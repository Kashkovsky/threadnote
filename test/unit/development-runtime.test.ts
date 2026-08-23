import {it as effectIt} from '@effect/vitest';
import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import fc from 'fast-check';
import {Effect, FileSystem, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  DEVELOPMENT_INSTALL_RECEIPT_VERSION,
  collectDevelopmentPayloadManifest,
  developmentBuildVersion,
  developmentPayloadManifestSha256,
  developmentVersionSourceCommit,
  isDevelopmentBuildVersion,
  parseDevelopmentInstallReceipt,
  prepareCanonicalDevelopmentInstallRoots,
  readDevelopmentReleaseEvidence,
  readManagedDevelopmentRuntimeEvidence,
  stageAndValidateDevelopmentRelease,
  verifyManagedDevelopmentRuntimeForSource,
  type DevelopmentInstallReceiptV1,
} from '../../scripts/development-runtime.js';
import {
  activateLocalStandaloneRelease,
  developmentRuntimeOwnershipConflict,
  parseLocalStandaloneInstallArguments,
} from '../../scripts/install-local-standalone.js';
import {commandLauncherPath, renderCommandShim} from '../../src/command-shim.js';
import {CommandExecutor, runCommandEffect} from '../../src/effect/command.js';
import {sha256FileHex} from '../../src/effect/digest.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';

const sourceCommitArbitrary = fc
  .constantFrom(40, 64)
  .chain(length =>
    fc
      .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: length, minLength: length})
      .map(characters => characters.join('')),
  );
const TEST_TARGET = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;

describe('exact-head development runtime', () => {
  it('parses only the explicit developer installer switches', () => {
    expect(parseLocalStandaloneInstallArguments(['--', '--terminate-superseded', '--json'])).toEqual({
      json: true,
      takeOverGlobalRuntime: false,
      terminateSuperseded: true,
    });
    expect(parseLocalStandaloneInstallArguments(['--take-over-global-runtime'])).toEqual({
      json: false,
      takeOverGlobalRuntime: true,
      terminateSuperseded: false,
    });
    expect(() => parseLocalStandaloneInstallArguments(['--force'])).toThrow('Unknown local standalone install option');
  });

  it('keeps global development runtime ownership stable across arbitrary checkout identities', () => {
    fc.assert(
      fc.property(sourceCommitArbitrary, sourceCommit => {
        const activeVersion = developmentBuildVersion('4.0.3', sourceCommit);
        const sourceCheckoutId = sourceCommit.padEnd(64, '0');
        const otherSourceCheckoutId = `${sourceCheckoutId[0] === '0' ? '1' : '0'}${sourceCheckoutId.slice(1)}`;
        const owner = {schemaVersion: 1 as const, sourceCheckoutId, version: activeVersion};

        expect(developmentRuntimeOwnershipConflict(activeVersion, owner, sourceCheckoutId)).toBeUndefined();
        expect(developmentRuntimeOwnershipConflict(activeVersion, owner, otherSourceCheckoutId)).toBe(
          'different-source-checkout',
        );
        expect(
          developmentRuntimeOwnershipConflict(
            developmentBuildVersion('4.0.3', otherSourceCheckoutId.slice(0, 40)),
            owner,
            sourceCheckoutId,
          ),
        ).toBe('untracked-development-activation');
        expect(developmentRuntimeOwnershipConflict(activeVersion, 'invalid', sourceCheckoutId)).toBe(
          'invalid-ownership-record',
        );
        expect(developmentRuntimeOwnershipConflict('4.0.3', owner, otherSourceCheckoutId)).toBeUndefined();
      }),
      {numRuns: 200},
    );
  });

  effectIt.effect(
    'requires an explicit takeover before another checkout can replace an active development runtime',
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const baseSystem = yield* SystemInfo;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-owner-'});
            const installRoot = path.join(root, 'install');
            const binRoot = path.join(root, 'bin');
            const sourceCommit = '9'.repeat(40);
            const version = developmentBuildVersion('4.0.3', sourceCommit);
            const releaseRoot = path.join(installRoot, 'versions', version);
            const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
            const firstCheckoutId = '1'.repeat(64);
            const secondCheckoutId = '2'.repeat(64);
            yield* writeDevelopmentReleaseFixture(
              fs,
              path,
              releaseRoot,
              version,
              sourceCommit,
              executableName,
              'owned-development-release',
            );
            yield* fs.writeFileString(
              path.join(installRoot, 'active-release.json'),
              `${JSON.stringify({releaseRoot, version})}\n`,
              {mode: 0o600},
            );
            const ownerFile = path.join(installRoot, 'development-runtime-owner.json');
            yield* fs.writeFileString(
              ownerFile,
              `${JSON.stringify({schemaVersion: 1, sourceCheckoutId: firstCheckoutId, version})}\n`,
              {mode: 0o600},
            );
            const testSystem = SystemInfo.of({
              ...baseSystem,
              environment: () => ({
                ...baseSystem.environment(),
                THREADNOTE_BIN_DIR: binRoot,
                THREADNOTE_INSTALL_ROOT: installRoot,
              }),
            });
            const canonicalInstallRoot = yield* fs.realPath(installRoot);
            const canonicalVersionsRoot = yield* fs.realPath(path.join(installRoot, 'versions'));
            const activation = (takeOverGlobalRuntime: boolean) =>
              activateLocalStandaloneRelease({
                canonicalInstallRoot,
                canonicalVersionsRoot,
                commit: sourceCommit,
                executableName,
                releaseRoot,
                reused: true,
                sourceCheckoutId: secondCheckoutId,
                stagedRoot: Option.none(),
                takeOverGlobalRuntime,
                terminateSuperseded: false,
                version,
              }).pipe(
                Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
                Effect.provideService(SystemInfo, testSystem),
              );

            const refusal = String(yield* activation(false).pipe(Effect.flip));
            const ownerAfterRefusal = yield* fs.readFileString(ownerFile);
            const installed = yield* activation(true);
            const ownerAfterTakeover = yield* fs.readFileString(ownerFile);
            return {installed, ownerAfterRefusal, ownerAfterTakeover, refusal, root};
          }),
        ).pipe(provideTestLayer(ApplicationLayer));

        expect(result.refusal).toContain('another source checkout owns');
        expect(JSON.parse(result.ownerAfterRefusal)).toMatchObject({sourceCheckoutId: '1'.repeat(64)});
        expect(JSON.parse(result.ownerAfterTakeover)).toMatchObject({sourceCheckoutId: '2'.repeat(64)});
        expect(result.ownerAfterTakeover).not.toContain(result.root);
        expect(result.installed.active).toBe(true);
      }),
  );

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

  it('accepts only exact 40- or 64-character Git object identities', () => {
    for (const length of [40, 64]) {
      expect(developmentBuildVersion('4.0.0-beta.30', 'a'.repeat(length))).toContain(`local.g${'a'.repeat(length)}`);
    }
    for (const length of [39, 41, 63, 65]) {
      expect(() => developmentBuildVersion('4.0.0-beta.30', 'a'.repeat(length))).toThrow('exact Git commit');
    }
  });

  it('rejects malformed or dirty provenance receipts', () => {
    const sourceCommit = 'a'.repeat(40);
    const receipt = validReceipt(developmentBuildVersion('4.0.0-beta.30', sourceCommit), sourceCommit);

    expect(Option.isSome(parseDevelopmentInstallReceipt(receipt))).toBe(true);
    expect(Option.isNone(parseDevelopmentInstallReceipt({...receipt, sourceDirty: true}))).toBe(true);
    expect(Option.isNone(parseDevelopmentInstallReceipt({...receipt, executableSha256: 'not-a-digest'}))).toBe(true);
    expect(Option.isNone(parseDevelopmentInstallReceipt({...receipt, sourceCommit: 'short'}))).toBe(true);
  });

  effectIt.effect('validates a managed release without exposing local paths', () =>
    Effect.gen(function* () {
      const evidence = yield* Effect.scoped(
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
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            releaseRoot,
            version,
            sourceCommit,
            executableName,
            'exact executable bytes',
          );
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
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(evidence).toMatchObject({
        runtime: 'bun-test',
        sourceCommit: 'b'.repeat(40),
        target: TEST_TARGET,
      });
      expect(Object.keys(evidence)).not.toContain('releaseRoot');
      expect(Object.keys(evidence)).not.toContain('executable');
    }),
  );

  effectIt.effect('allows a superseded stable transport only after its executable child promotes', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-runtime-transport-'});
          const sourceCommit = 'd'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const supersededVersion = '4.0.0-beta.29';
          const installRoot = path.join(root, 'install');
          const releaseRoot = path.join(installRoot, 'versions', version);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            releaseRoot,
            version,
            sourceCommit,
            executableName,
            'exact executable bytes',
          );
          yield* fs.writeFileString(
            path.join(installRoot, 'active-release.json'),
            `${JSON.stringify({releaseRoot, version})}\n`,
          );
          const brokerProcessId = 46_001;
          const childProcessId = 46_002;
          for (const lease of [
            {
              processId: brokerProcessId,
              processStartIdentity: 'broker-process',
              retirementPolicy: 'preserve-session',
              version: supersededVersion,
            },
            {
              parentProcessId: brokerProcessId,
              processId: childProcessId,
              processStartIdentity: 'mcp-process',
              retirementPolicy: 'terminate',
              version,
            },
          ] as const) {
            const leaseRoot = path.join(installRoot, 'leases', lease.version);
            yield* fs.makeDirectory(leaseRoot, {recursive: true});
            yield* fs.writeFileString(
              path.join(leaseRoot, `${lease.processId}.json`),
              `${JSON.stringify({...lease, token: `lease-${lease.processId}`})}\n`,
            );
          }
          const identities = new Map([
            [brokerProcessId, 'broker-process'],
            [childProcessId, 'mcp-process'],
          ]);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
            isProcessRunning: processId => identities.has(processId),
            processStartIdentity: processId => Effect.succeed(identities.get(processId)),
          });
          const commandExecutor = versionCommandExecutor(version);
          const accepted = yield* verifyManagedDevelopmentRuntimeForSource(sourceCommit).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(SystemInfo, testSystem),
          );
          const childLeasePath = path.join(installRoot, 'leases', version, `${childProcessId}.json`);
          const supersededChildLeaseRoot = path.join(installRoot, 'leases', supersededVersion);
          yield* fs.remove(childLeasePath, {force: true});
          yield* fs.writeFileString(
            path.join(supersededChildLeaseRoot, `${childProcessId}.json`),
            `${JSON.stringify({
              parentProcessId: brokerProcessId,
              processId: childProcessId,
              processStartIdentity: 'mcp-process',
              retirementPolicy: 'terminate',
              token: `lease-${childProcessId}`,
              version: supersededVersion,
            })}\n`,
          );
          const rejected = yield* verifyManagedDevelopmentRuntimeForSource(sourceCommit).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
          return {accepted, rejected: String(rejected)};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.accepted.sourceCommit).toBe('d'.repeat(40));
      expect(result.rejected).toContain('process pinned to a superseded release');
    }),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'rejects payload content, membership, mode, link, and receipt-permission changes',
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const baseSystem = yield* SystemInfo;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-payload-'});
            const sourceCommit = '7'.repeat(40);
            const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
            const releaseRoot = path.join(root, 'release');
            const executableName = 'threadnote';
            yield* writeDevelopmentReleaseFixture(
              fs,
              path,
              releaseRoot,
              version,
              sourceCommit,
              executableName,
              'payload-release',
            );
            const nested = path.join(releaseRoot, 'assets', 'nested.txt');
            yield* fs.makeDirectory(path.dirname(nested), {recursive: true});
            yield* fs.writeFileString(nested, 'original payload\n', {mode: 0o644});
            yield* refreshDevelopmentReceipt(fs, path, releaseRoot, version, sourceCommit, executableName);
            const commandExecutor = versionCommandExecutor(version);
            const validate = readDevelopmentReleaseEvidence(releaseRoot, sourceCommit).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(SystemInfo, baseSystem),
            );
            yield* validate;

            yield* fs.writeFileString(nested, 'mutated payload\n');
            const contentFailure = String(yield* validate.pipe(Effect.flip));
            yield* fs.writeFileString(nested, 'original payload\n');

            const unexpected = path.join(releaseRoot, 'unexpected.txt');
            yield* fs.writeFileString(unexpected, 'unexpected\n');
            const membershipFailure = String(yield* validate.pipe(Effect.flip));
            yield* fs.remove(unexpected);

            yield* fs.chmod(nested, 0o600);
            const modeFailure = String(yield* validate.pipe(Effect.flip));
            yield* fs.chmod(nested, 0o644);

            const specialPayloadModeFileSystem = FileSystem.FileSystem.of({
              ...fs,
              stat: file =>
                fs
                  .stat(file)
                  .pipe(
                    Effect.map(info =>
                      path.basename(file) === 'nested.txt' ? {...info, mode: info.mode | 0o4000} : info,
                    ),
                  ),
            });
            const specialModeFailure = String(
              yield* validate.pipe(
                Effect.provideService(FileSystem.FileSystem, specialPayloadModeFileSystem),
                Effect.flip,
              ),
            );

            const linked = path.join(releaseRoot, 'linked.txt');
            yield* fs.symlink(nested, linked);
            const linkFailure = String(yield* validate.pipe(Effect.flip));
            yield* fs.remove(linked);

            const receiptPath = path.join(releaseRoot, 'development-install.json');
            const specialReceiptModeFileSystem = FileSystem.FileSystem.of({
              ...fs,
              stat: file =>
                fs
                  .stat(file)
                  .pipe(
                    Effect.map(info =>
                      path.basename(file) === 'development-install.json' ? {...info, mode: info.mode | 0o4000} : info,
                    ),
                  ),
            });
            const receiptSpecialModeFailure = String(
              yield* validate.pipe(
                Effect.provideService(FileSystem.FileSystem, specialReceiptModeFileSystem),
                Effect.flip,
              ),
            );
            yield* fs.chmod(receiptPath, 0o644);
            const receiptModeFailure = String(yield* validate.pipe(Effect.flip));
            return {
              contentFailure,
              linkFailure,
              membershipFailure,
              modeFailure,
              receiptModeFailure,
              receiptSpecialModeFailure,
              specialModeFailure,
            };
          }),
        ).pipe(provideTestLayer(ApplicationLayer));

        expect(result.contentFailure).toContain('payload manifest does not match');
        expect(result.membershipFailure).toContain('payload manifest does not match');
        expect(result.modeFailure).toContain('payload manifest does not match');
        expect(result.specialModeFailure).toContain('unsupported special permission bits');
        expect(result.linkFailure).toContain('must not contain symbolic links');
        expect(result.receiptModeFailure).toContain('unsafe permissions');
        expect(result.receiptSpecialModeFailure).toContain('unsafe permissions');
      }),
  );

  effectIt.effect('rejects an otherwise attested payload compiled for another host target', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-wrong-target-'});
          const sourceCommit = '6'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const releaseRoot = path.join(root, 'release');
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            releaseRoot,
            version,
            sourceCommit,
            executableName,
            'wrong-target-release',
          );
          const wrongTarget = baseSystem.platform === 'linux' ? 'bun-darwin-x64' : 'bun-linux-x64';
          yield* fs.writeFileString(
            path.join(releaseRoot, 'release.json'),
            `${JSON.stringify({executable: executableName, runtime: 'bun-test', target: wrongTarget, version})}\n`,
          );
          yield* refreshDevelopmentReceipt(fs, path, releaseRoot, version, sourceCommit, executableName, wrongTarget);
          return yield* readDevelopmentReleaseEvidence(releaseRoot, sourceCommit).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(SystemInfo, baseSystem),
            Effect.flip,
          );
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(String(failure)).toContain('does not match the exact source commit');
    }),
  );

  effectIt.effect.skipIf(process.platform === 'win32')('rejects a symlinked managed release directory', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.scoped(
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
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(String(failure)).toContain('escapes the versions root');
    }),
  );

  effectIt.effect.skipIf(process.platform === 'win32')('rejects a symlinked managed versions directory', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.scoped(
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
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(String(failure)).toContain('versions directory is not canonical');
    }),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'rejects a symlinked versions root before build or staging',
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const baseSystem = yield* SystemInfo;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-prestage-link-'});
            const installRoot = path.join(root, 'install');
            const outsideVersionsRoot = path.join(root, 'outside-versions');
            yield* fs.makeDirectory(installRoot, {recursive: true});
            yield* fs.makeDirectory(outsideVersionsRoot, {recursive: true});
            yield* fs.symlink(outsideVersionsRoot, path.join(installRoot, 'versions'));
            return yield* prepareCanonicalDevelopmentInstallRoots(installRoot).pipe(
              Effect.provideService(SystemInfo, baseSystem),
              Effect.flip,
            );
          }),
        ).pipe(provideTestLayer(ApplicationLayer));

        expect(String(failure)).toContain('must not be a symbolic link');
      }),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'supports a canonical install root reached through a parent symlink',
    () =>
      Effect.gen(function* () {
        const evidence = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const baseSystem = yield* SystemInfo;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-parent-link-'});
            const realInstallRoot = path.join(root, 'physical-install');
            const logicalInstallRoot = path.join(root, 'logical-install');
            const sourceCommit = '9'.repeat(40);
            const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
            const executableName = 'threadnote';
            const realReleaseRoot = path.join(realInstallRoot, 'versions', version);
            yield* writeDevelopmentReleaseFixture(
              fs,
              path,
              realReleaseRoot,
              version,
              sourceCommit,
              executableName,
              'parent-link-release',
            );
            yield* fs.symlink(realInstallRoot, logicalInstallRoot);
            yield* fs.writeFileString(
              path.join(logicalInstallRoot, 'active-release.json'),
              `${JSON.stringify({releaseRoot: path.join(logicalInstallRoot, 'versions', version), version})}\n`,
            );
            const testSystem = SystemInfo.of({
              ...baseSystem,
              environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: logicalInstallRoot}),
            });
            const roots = yield* prepareCanonicalDevelopmentInstallRoots(logicalInstallRoot).pipe(
              Effect.provideService(SystemInfo, testSystem),
            );
            const runtime = yield* readManagedDevelopmentRuntimeEvidence(sourceCommit).pipe(
              Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
              Effect.provideService(SystemInfo, testSystem),
            );
            return {roots, runtime};
          }),
        ).pipe(provideTestLayer(ApplicationLayer));

        expect(evidence.roots.installRoot).toContain('physical-install');
        expect(evidence.runtime.version).toContain(`local.g${'9'.repeat(40)}`);
      }),
  );

  effectIt.effect('binds managed provenance to the active pointer version', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.scoped(
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
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(String(failure)).toContain('pointer and release version do not match');
    }),
  );

  effectIt.effect('revalidates a reused release under the installation lock before writing launchers', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
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
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            releaseRoot,
            version,
            sourceCommit,
            executableName,
            'reusable executable bytes',
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
            canonicalInstallRoot: yield* fs.realPath(installRoot),
            canonicalVersionsRoot: yield* fs.realPath(path.join(installRoot, 'versions')),
            commit: sourceCommit,
            executableName,
            releaseRoot,
            reused: true,
            sourceCheckoutId: 'a'.repeat(64),
            stagedRoot: Option.none(),
            takeOverGlobalRuntime: false,
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
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.failure).toContain('not reusable');
      expect(result.activePointerExists).toBe(false);
      expect(result.binRootExists).toBe(false);
    }),
  );

  effectIt.effect('reuses a valid same-version release that wins while another stage waits for the lock', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
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
            canonicalInstallRoot: yield* fs.realPath(installRoot),
            canonicalVersionsRoot: yield* fs.realPath(path.join(installRoot, 'versions')),
            commit: sourceCommit,
            executableName,
            releaseRoot,
            reused: false,
            sourceCheckoutId: 'a'.repeat(64),
            stagedRoot: Option.some(stagedRoot),
            takeOverGlobalRuntime: false,
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
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.installed.reused).toBe(true);
      expect(result.releaseBytes).toBe('concurrent-winner\n');
      expect(result.stagedExists).toBe(false);
    }),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'repairs exact managed launcher modes and executes the CLI launcher before success',
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const baseSystem = yield* SystemInfo;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-launcher-mode-'});
            const installRoot = path.join(root, 'install');
            const binRoot = path.join(root, 'bin');
            const sourceCommit = '8'.repeat(40);
            const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
            const releaseRoot = path.join(installRoot, 'versions', version);
            yield* writeDevelopmentReleaseFixture(
              fs,
              path,
              releaseRoot,
              version,
              sourceCommit,
              'threadnote',
              'launcher-mode-release',
            );
            const testSystem = SystemInfo.of({
              ...baseSystem,
              environment: () => ({
                ...baseSystem.environment(),
                THREADNOTE_BIN_DIR: binRoot,
                THREADNOTE_INSTALL_ROOT: installRoot,
              }),
            });
            const [cliLauncher, mcpLauncher, cliBody, mcpBody] = yield* Effect.all([
              commandLauncherPath('cli'),
              commandLauncherPath('mcp'),
              renderCommandShim(releaseRoot, 'cli'),
              renderCommandShim(releaseRoot, 'mcp'),
            ]).pipe(Effect.provideService(SystemInfo, testSystem));
            yield* fs.makeDirectory(binRoot, {recursive: true});
            yield* fs.writeFileString(cliLauncher, cliBody, {mode: 0o644});
            yield* fs.writeFileString(mcpLauncher, mcpBody, {mode: 0o777});
            yield* fs.chmod(cliLauncher, 0o644);
            yield* fs.chmod(mcpLauncher, 0o777);
            const invocations: Array<{readonly arguments: readonly string[]; readonly executable: string}> = [];
            const executor = CommandExecutor.of({
              execute: (executable, arguments_) => {
                invocations.push({arguments: arguments_, executable});
                return Effect.succeed({
                  exitCode: 0,
                  stderr: '',
                  stdout:
                    arguments_[0] === 'doctor'
                      ? 'Running Threadnote doctor checks.\nSummary: all checks complete.\n'
                      : `threadnote v${version}\n`,
                });
              },
              executeStreaming: () => Effect.die(new TestError('Unexpected streaming command')),
            });
            const installed = yield* activateLocalStandaloneRelease({
              canonicalInstallRoot: yield* fs.realPath(installRoot),
              canonicalVersionsRoot: yield* fs.realPath(path.join(installRoot, 'versions')),
              commit: sourceCommit,
              executableName: 'threadnote',
              releaseRoot,
              reused: true,
              sourceCheckoutId: 'a'.repeat(64),
              stagedRoot: Option.none(),
              takeOverGlobalRuntime: false,
              terminateSuperseded: false,
              version,
            }).pipe(Effect.provideService(CommandExecutor, executor), Effect.provideService(SystemInfo, testSystem));
            return {
              cliMode: (yield* fs.stat(cliLauncher)).mode & 0o777,
              installed,
              invocations,
              mcpMode: (yield* fs.stat(mcpLauncher)).mode & 0o777,
              cliLauncher,
            };
          }),
        ).pipe(provideTestLayer(ApplicationLayer));

        expect(result.installed.launchersVerified).toBe(true);
        expect(result.cliMode).toBe(0o755);
        expect(result.mcpMode).toBe(0o755);
        expect(result.invocations).toContainEqual({arguments: ['--version'], executable: result.cliLauncher});
      }),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'executes the real POSIX CLI launcher before reporting success',
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const baseSystem = yield* SystemInfo;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-real-launcher-'});
            const installRoot = path.join(root, 'install');
            const binRoot = path.join(root, 'bin');
            const sourceCommit = '4'.repeat(40);
            const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
            const releaseRoot = path.join(installRoot, 'versions', version);
            yield* writeDevelopmentReleaseFixture(
              fs,
              path,
              releaseRoot,
              version,
              sourceCommit,
              'threadnote',
              'placeholder',
            );
            const executable = path.join(releaseRoot, 'threadnote');
            yield* fs.writeFileString(
              executable,
              [
                '#!/bin/sh',
                'if [ "$1" = "doctor" ]; then',
                "  printf '%s\\n' 'Running Threadnote doctor checks.' 'Summary: all checks complete.'",
                'elif [ "$1" = "--version" ]; then',
                `  printf '%s\\n' 'threadnote v${version}'`,
                'else',
                '  exit 64',
                'fi',
                '',
              ].join('\n'),
              {mode: 0o755},
            );
            yield* fs.chmod(executable, 0o755);
            yield* refreshDevelopmentReceipt(fs, path, releaseRoot, version, sourceCommit, 'threadnote');
            const testSystem = SystemInfo.of({
              ...baseSystem,
              environment: () => ({
                ...baseSystem.environment(),
                THREADNOTE_BIN_DIR: binRoot,
                THREADNOTE_INSTALL_ROOT: installRoot,
              }),
            });
            const installed = yield* activateLocalStandaloneRelease({
              canonicalInstallRoot: yield* fs.realPath(installRoot),
              canonicalVersionsRoot: yield* fs.realPath(path.join(installRoot, 'versions')),
              commit: sourceCommit,
              executableName: 'threadnote',
              releaseRoot,
              reused: true,
              sourceCheckoutId: 'a'.repeat(64),
              stagedRoot: Option.none(),
              takeOverGlobalRuntime: false,
              terminateSuperseded: false,
              version,
            }).pipe(Effect.provideService(SystemInfo, testSystem));
            const launcher = yield* commandLauncherPath('cli').pipe(Effect.provideService(SystemInfo, testSystem));
            const versionResult = yield* runCommandEffect(launcher, ['--version']).pipe(
              Effect.provideService(SystemInfo, testSystem),
            );
            return {installed, launcherMode: (yield* fs.stat(launcher)).mode & 0o777, versionResult};
          }),
        ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);

        expect(result.installed.launchersVerified).toBe(true);
        expect(result.launcherMode).toBe(0o755);
        expect(result.versionResult.stdout.trim()).toBe(`threadnote v${result.installed.version}`);
      }),
  );

  effectIt.effect('retires the old MCP runtime below a preserved stable broker when requested', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-preserved-session-'});
          const installRoot = path.join(root, 'install');
          const binRoot = path.join(root, 'bin');
          const sourceCommit = '7'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const supersededVersion = '4.0.0-beta.29';
          const releaseRoot = path.join(installRoot, 'versions', version);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            releaseRoot,
            version,
            sourceCommit,
            executableName,
            'preserved-session-release',
          );
          const leases = [
            {
              processId: 45_001,
              processStartIdentity: 'broker-process',
              retirementPolicy: 'preserve-session',
            },
            {
              parentProcessId: 45_001,
              processId: 45_002,
              processStartIdentity: 'mcp-process',
              retirementPolicy: 'terminate',
            },
            {
              parentProcessId: 45_002,
              processId: 45_003,
              processStartIdentity: 'worker-process',
              retirementPolicy: 'terminate',
            },
            {
              processId: 45_004,
              processStartIdentity: 'cli-process',
              retirementPolicy: 'terminate',
            },
          ] as const;
          const leasesRoot = path.join(installRoot, 'leases', supersededVersion);
          yield* fs.makeDirectory(leasesRoot, {recursive: true});
          for (const lease of leases) {
            yield* fs.writeFileString(
              path.join(leasesRoot, `${lease.processId}.json`),
              `${JSON.stringify({
                ...lease,
                startedAt: '2026-08-02T08:00:00.000Z',
                token: `lease-${lease.processId}`,
                version: supersededVersion,
              })}\n`,
            );
          }
          const identities = new Map<number, string>(
            leases.map(lease => [lease.processId, lease.processStartIdentity]),
          );
          const running = new Set<number>(leases.map(lease => lease.processId));
          const signals: Array<readonly [number, NodeJS.Signals]> = [];
          let terminationRequested = false;
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
            isProcessRunning: processId => running.has(processId),
            processId: 99_999,
            processStartIdentity: processId => Effect.succeed(identities.get(processId)),
            signalProcess: (processId, signal) => {
              if (!terminationRequested) {
                throw new TestError('Installer must not signal processes without --terminate-superseded');
              }
              signals.push([processId, signal]);
              running.delete(processId);
            },
          });
          const activation = {
            canonicalInstallRoot: yield* fs.realPath(installRoot),
            canonicalVersionsRoot: yield* fs.realPath(path.join(installRoot, 'versions')),
            commit: sourceCommit,
            executableName,
            releaseRoot,
            reused: true,
            sourceCheckoutId: 'a'.repeat(64),
            stagedRoot: Option.none(),
            takeOverGlobalRuntime: false,
            terminateSuperseded: false,
            version,
          } as const;
          const preserved = yield* activateLocalStandaloneRelease(activation).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(SystemInfo, testSystem),
          );
          terminationRequested = true;
          const cleaned = yield* activateLocalStandaloneRelease({...activation, terminateSuperseded: true}).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(SystemInfo, testSystem),
          );
          return {cleaned, preserved, running, signals};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.preserved).toMatchObject({
        cleanupComplete: false,
        cleanupIssues: [],
        preservedMcpSessionProcesses: 3,
        remainingSupersededProcesses: 1,
        terminatedSupersededProcesses: 0,
      });
      expect(result.signals).toEqual([
        [45_002, 'SIGTERM'],
        [45_004, 'SIGTERM'],
        [45_003, 'SIGTERM'],
      ]);
      expect(result.cleaned).toMatchObject({
        cleanupComplete: true,
        cleanupIssues: [],
        preservedMcpSessionProcesses: 1,
        remainingSupersededProcesses: 0,
        terminatedSupersededProcesses: 3,
      });
      expect([...result.running]).toEqual([45_001]);
    }),
  );

  effectIt.effect('restores the prior active pointer and launchers when launcher verification fails', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
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
            canonicalInstallRoot: yield* fs.realPath(installRoot),
            canonicalVersionsRoot: yield* fs.realPath(path.join(installRoot, 'versions')),
            commit: sourceCommit,
            executableName,
            releaseRoot,
            reused: true,
            sourceCheckoutId: 'a'.repeat(64),
            stagedRoot: Option.none(),
            takeOverGlobalRuntime: false,
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
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.failure).toContain('managed mcp launcher did not activate');
      expect(result.activePointer).toBe(result.priorPointer);
      expect(result.cli).toBe(result.priorCli);
      expect(result.mcp).toBe('unmanaged launcher\n');
    }),
  );

  effectIt.effect('attempts every rollback restore and surfaces multiple independent restore failures', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-rollback-aggregate-'});
          const sourceCommit = '5'.repeat(40);
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
            'aggregate-rollback-release',
          );
          yield* fs.makeDirectory(priorReleaseRoot, {recursive: true});
          const activePointer = path.join(installRoot, 'active-release.json');
          const priorPointer = `${JSON.stringify({releaseRoot: priorReleaseRoot, version: priorVersion})}\n`;
          yield* fs.writeFileString(activePointer, priorPointer, {mode: 0o600});
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });
          const [cliLauncher, mcpLauncher, priorCli] = yield* Effect.all([
            commandLauncherPath('cli'),
            commandLauncherPath('mcp'),
            renderCommandShim(priorReleaseRoot, 'cli'),
          ]).pipe(Effect.provideService(SystemInfo, testSystem));
          yield* fs.makeDirectory(binRoot, {recursive: true});
          yield* fs.writeFileString(cliLauncher, priorCli, {mode: 0o755});
          yield* fs.writeFileString(mcpLauncher, 'unmanaged launcher\n', {mode: 0o755});
          const rollbackAttempts: string[] = [];
          const failingFileSystem = FileSystem.FileSystem.of({
            ...fs,
            rename: (source, target) => {
              if (source.endsWith('.rollback')) {
                rollbackAttempts.push(target);
                if (target === cliLauncher || target === mcpLauncher) {
                  return fs.rename(path.join(root, `injected-missing-${path.basename(target)}`), target);
                }
              }
              return fs.rename(source, target);
            },
          });
          const failure = yield* activateLocalStandaloneRelease({
            canonicalInstallRoot: yield* fs.realPath(installRoot),
            canonicalVersionsRoot: yield* fs.realPath(path.join(installRoot, 'versions')),
            commit: sourceCommit,
            executableName,
            releaseRoot,
            reused: true,
            sourceCheckoutId: 'a'.repeat(64),
            stagedRoot: Option.none(),
            takeOverGlobalRuntime: false,
            terminateSuperseded: false,
            version,
          }).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
          return {
            activePointer: yield* fs.readFileString(activePointer),
            errorMessages: nestedErrorMessages(failure),
            failure: String(failure),
            rollbackAttempts,
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.failure).toContain('rollback was incomplete');
      expect(result.rollbackAttempts).toHaveLength(3);
      expect(result.errorMessages.filter(message => message.startsWith('Could not restore the'))).toHaveLength(2);
      expect(result.activePointer).toContain('4.0.0-beta.29');
    }),
  );

  effectIt.effect('keeps a valid activation active while reporting independent cleanup failures', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-cleanup-failures-'});
          const sourceCommit = '6'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const installRoot = path.join(root, 'install');
          const binRoot = path.join(root, 'bin');
          const releaseRoot = path.join(installRoot, 'versions', version);
          const stagedRoot = path.join(installRoot, 'versions', `.${version}.fixture.staging`);
          const leasesRoot = path.join(installRoot, 'leases');
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            releaseRoot,
            version,
            sourceCommit,
            executableName,
            'cleanup-active-release',
          );
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            stagedRoot,
            version,
            sourceCommit,
            executableName,
            'cleanup-disposable-stage',
          );
          yield* fs.makeDirectory(leasesRoot, {recursive: true});
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });
          const missing = path.join(root, 'injected-missing-path');
          const failingFileSystem = FileSystem.FileSystem.of({
            ...fs,
            readDirectory: directory =>
              directory === leasesRoot ? fs.readDirectory(missing) : fs.readDirectory(directory),
            remove: (target, options) =>
              target === stagedRoot ? fs.rename(missing, path.join(root, 'never-created')) : fs.remove(target, options),
          });
          const installed = yield* activateLocalStandaloneRelease({
            canonicalInstallRoot: yield* fs.realPath(installRoot),
            canonicalVersionsRoot: yield* fs.realPath(path.join(installRoot, 'versions')),
            commit: sourceCommit,
            executableName,
            releaseRoot,
            reused: false,
            sourceCheckoutId: 'a'.repeat(64),
            stagedRoot: Option.some(stagedRoot),
            takeOverGlobalRuntime: false,
            terminateSuperseded: false,
            version,
          }).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
            Effect.provideService(SystemInfo, testSystem),
          );
          return {
            activePointer: JSON.parse(yield* fs.readFileString(path.join(installRoot, 'active-release.json'))) as {
              readonly version: string;
            },
            installed,
            stagedExists: yield* fs.exists(stagedRoot),
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.installed).toMatchObject({
        active: true,
        cleanupComplete: false,
        cleanupIssues: ['process-inspection', 'release-pruning', 'staging-removal'],
        doctorVerified: true,
        launchersVerified: true,
      });
      expect(result.activePointer.version).toBe(result.installed.version);
      expect(result.stagedExists).toBe(true);
    }),
  );

  effectIt.effect('removes a disposable staging directory when pre-activation validation fails', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-stage-'});
          const sourceCommit = 'c'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const distributionRoot = path.join(root, 'dist');
          const versionsRoot = path.join(root, 'versions');
          const stagedRoot = path.join(versionsRoot, `.${version}.fixture.staging`);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* fs.makeDirectory(distributionRoot, {recursive: true});
          yield* fs.writeFileString(path.join(distributionRoot, executableName), 'built executable bytes\n');
          if (baseSystem.platform !== 'win32') {
            yield* fs.chmod(path.join(distributionRoot, executableName), 0o755);
          }
          yield* fs.writeFileString(
            path.join(distributionRoot, 'release.json'),
            `${JSON.stringify({executable: executableName, runtime: 'bun-test', target: TEST_TARGET, version})}\n`,
          );
          const payloadManifest = yield* collectDevelopmentPayloadManifest(distributionRoot);
          const receipt = validReceipt(version, sourceCommit, {
            // A syntactically valid but intentionally wrong digest forces the
            // validation failure after the stage has been copied and written.
            executableSha256: '0'.repeat(64),
            payloadManifest,
            payloadManifestSha256: yield* developmentPayloadManifestSha256(payloadManifest),
            releaseMetadataSha256: yield* sha256FileHex(path.join(distributionRoot, 'release.json')),
          });
          yield* fs.makeDirectory(versionsRoot, {recursive: true});
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
            versionsRoot,
          }).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
          return {failure: String(failure), stagedExists: yield* fs.exists(stagedRoot)};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.failure).toContain('failed validation before activation');
      expect(result.stagedExists).toBe(false);
    }),
  );
});

function validReceipt(
  version: string,
  sourceCommit: string,
  overrides: Partial<DevelopmentInstallReceiptV1> = {},
): DevelopmentInstallReceiptV1 {
  return {
    builtAt: '2026-08-02T08:00:00.000Z',
    dependencyInstallation: 'bun install --frozen-lockfile',
    executableSha256: '1'.repeat(64),
    payloadManifest: [{mode: 0o644, path: 'release.json', sha256: '3'.repeat(64), size: 1}],
    payloadManifestSha256: '4'.repeat(64),
    releaseMetadataSha256: '2'.repeat(64),
    runtime: 'bun-test',
    schemaVersion: DEVELOPMENT_INSTALL_RECEIPT_VERSION,
    sourceCommit,
    sourceDirty: false,
    sourceLockfileSha256: '5'.repeat(64),
    sourcePackageManifestSha256: '6'.repeat(64),
    target: TEST_TARGET,
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
    executeStreaming: () => Effect.die(new TestError('Unexpected streaming command')),
  });
}

function nestedErrorMessages(value: unknown): readonly string[] {
  if (value instanceof AggregateError) {
    return [value.message, ...value.errors.flatMap(nestedErrorMessages)];
  }
  if (value instanceof Error) {
    return [value.message, ...nestedErrorMessages(value.cause)];
  }
  return [];
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
    if (process.platform !== 'win32') yield* fs.chmod(path.join(releaseRoot, executableName), 0o755);
    yield* fs.writeFileString(
      path.join(releaseRoot, 'release.json'),
      `${JSON.stringify({executable: executableName, runtime: 'bun-test', target: TEST_TARGET, version})}\n`,
    );
    yield* refreshDevelopmentReceipt(fs, path, releaseRoot, version, sourceCommit, executableName);
  });
}

function refreshDevelopmentReceipt(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
  version: string,
  sourceCommit: string,
  executableName: string,
  target = TEST_TARGET,
) {
  return Effect.gen(function* () {
    const receiptPath = path.join(releaseRoot, 'development-install.json');
    yield* fs.remove(receiptPath, {force: true});
    const payloadManifest = yield* collectDevelopmentPayloadManifest(releaseRoot);
    yield* fs.writeFileString(
      receiptPath,
      `${JSON.stringify(
        validReceipt(version, sourceCommit, {
          executableSha256: yield* sha256FileHex(path.join(releaseRoot, executableName)),
          payloadManifest,
          payloadManifestSha256: yield* developmentPayloadManifestSha256(payloadManifest),
          releaseMetadataSha256: yield* sha256FileHex(path.join(releaseRoot, 'release.json')),
          target,
        }),
      )}\n`,
      {mode: 0o600},
    );
    if (process.platform !== 'win32') yield* fs.chmod(receiptPath, 0o600);
  });
}
