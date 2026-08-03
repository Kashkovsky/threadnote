import {Effect, FileSystem, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {SystemInfo, type SystemInfoShape} from '../../src/effect/system.js';
import {
  activateStandaloneRelease,
  activeInstalledVersion,
  promoteStandaloneReleaseDirectory,
  pruneStandaloneReleases,
  recoverStandaloneReleasePromotion,
  withStandaloneInstallationLock,
} from '../../src/installations.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  readValidatedRelease,
  readStandaloneProcessLeaseVerification,
  terminateSupersededStandaloneProcesses,
} from '../../src/standalone_process_lease.js';

describe('standalone release lifecycle', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects release-directory symlinks during lifecycle validation',
    async () => {
      const validated = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-release-link-validation-'});
            const installRoot = path.join(root, 'install');
            const outsideRelease = path.join(root, 'outside-release');
            const linkedRelease = path.join(installRoot, 'versions', '4.0.0');
            yield* fs.makeDirectory(path.dirname(linkedRelease), {recursive: true});
            yield* fs.makeDirectory(outsideRelease);
            yield* fs.writeFileString(
              path.join(outsideRelease, 'release.json'),
              `${JSON.stringify({version: '4.0.0'})}\n`,
            );
            yield* fs.symlink(outsideRelease, linkedRelease);
            return yield* readValidatedRelease(fs, path, linkedRelease, installRoot);
          }),
        ).pipe(Effect.provide(ApplicationLayer)),
      );

      expect(validated).toBeUndefined();
    },
  );

  it('tracks the active release and retains only it plus the running rollback version', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-installations-test-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const versionsRoot = path.join(installRoot, 'versions');
          for (const version of ['4.0.0', '4.0.1', '4.0.2']) {
            const releaseRoot = path.join(versionsRoot, version);
            yield* fs.makeDirectory(releaseRoot, {recursive: true});
            yield* fs.writeFileString(
              path.join(releaseRoot, 'release.json'),
              `${JSON.stringify({executable: 'threadnote', version})}\n`,
            );
          }
          const runningRelease = path.join(versionsRoot, '4.0.1');
          const activeRelease = path.join(versionsRoot, '4.0.2');
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
            executablePath: path.join(runningRelease, 'threadnote'),
          });

          yield* activateStandaloneRelease(activeRelease, false).pipe(Effect.provideService(SystemInfo, testSystem));
          const activeVersion = yield* activeInstalledVersion().pipe(Effect.provideService(SystemInfo, testSystem));
          yield* pruneStandaloneReleases(activeRelease, false).pipe(Effect.provideService(SystemInfo, testSystem));
          return {
            activeVersion,
            oldestExists: yield* fs.exists(path.join(versionsRoot, '4.0.0')),
            rollbackExists: yield* fs.exists(runningRelease),
            activeExists: yield* fs.exists(activeRelease),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      activeExists: true,
      activeVersion: '4.0.2',
      oldestExists: false,
      rollbackExists: true,
    });
  });

  it('retains a superseded release while a live MCP or CLI process leases it', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-installations-lease-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const versionsRoot = path.join(installRoot, 'versions');
          for (const version of ['4.0.0', '4.0.1', '4.0.2']) {
            const releaseRoot = path.join(versionsRoot, version);
            yield* fs.makeDirectory(releaseRoot, {recursive: true});
            yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), `${JSON.stringify({version})}\n`);
          }
          const leasedProcessId = 1_234_567;
          const leaseRoot = path.join(installRoot, 'leases', '4.0.0');
          yield* fs.makeDirectory(leaseRoot, {recursive: true});
          yield* fs.writeFileString(
            path.join(leaseRoot, `${leasedProcessId}.json`),
            `${JSON.stringify({processId: leasedProcessId, token: 'live-test-lease', version: '4.0.0'})}\n`,
          );
          const activeRelease = path.join(versionsRoot, '4.0.2');
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
            executablePath: path.join(versionsRoot, '4.0.1', 'threadnote'),
            isProcessRunning: processId => processId === leasedProcessId,
          });

          yield* pruneStandaloneReleases(activeRelease, false).pipe(Effect.provideService(SystemInfo, testSystem));
          return {
            activeExists: yield* fs.exists(activeRelease),
            leasedExists: yield* fs.exists(path.join(versionsRoot, '4.0.0')),
            runningExists: yield* fs.exists(path.join(versionsRoot, '4.0.1')),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      activeExists: true,
      leasedExists: true,
      runningExists: true,
    });
  });

  it('discards a lease when its process ID has been reused by another process', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-installations-reused-pid-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const versionsRoot = path.join(installRoot, 'versions');
          for (const version of ['4.0.0', '4.0.1', '4.0.2']) {
            const releaseRoot = path.join(versionsRoot, version);
            yield* fs.makeDirectory(releaseRoot, {recursive: true});
            yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), `${JSON.stringify({version})}\n`);
          }
          const reusedProcessId = 1_234_567;
          const leasePath = path.join(installRoot, 'leases', '4.0.0', `${reusedProcessId}.json`);
          yield* fs.makeDirectory(path.dirname(leasePath), {recursive: true});
          yield* fs.writeFileString(
            leasePath,
            `${JSON.stringify({
              processId: reusedProcessId,
              processStartIdentity: 'original-process',
              token: 'stale-test-lease',
              version: '4.0.0',
            })}\n`,
          );
          const activeRelease = path.join(versionsRoot, '4.0.2');
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
            executablePath: path.join(versionsRoot, '4.0.1', 'threadnote'),
            isProcessRunning: processId => processId === reusedProcessId,
            processStartIdentity: () => Effect.succeed('replacement-process'),
          });

          yield* pruneStandaloneReleases(activeRelease, false).pipe(Effect.provideService(SystemInfo, testSystem));
          return {
            leaseExists: yield* fs.exists(leasePath),
            staleReleaseExists: yield* fs.exists(path.join(versionsRoot, '4.0.0')),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      leaseExists: false,
      staleReleaseExists: false,
    });
  });

  it('serializes concurrent installation mutations', async () => {
    const maximumActive = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-installations-lock-'});
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_INSTALL_ROOT: path.join(temporaryRoot, 'install'),
            }),
          });
          let active = 0;
          let maximum = 0;
          const mutation = withStandaloneInstallationLock(
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                active += 1;
                maximum = Math.max(maximum, active);
              });
              yield* Effect.sleep(25);
              yield* Effect.sync(() => {
                active -= 1;
              });
            }),
          ).pipe(Effect.provideService(SystemInfo, testSystem));
          yield* Effect.all([mutation, mutation, mutation], {concurrency: 3});
          return maximum;
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(maximumActive).toBe(1);
  });

  it('recovers an interrupted active-pointer backup before the next activation', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-active-recovery-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const versionsRoot = path.join(installRoot, 'versions');
          const oldRelease = yield* createRelease(fs, path, versionsRoot, '4.0.1', 'old');
          const newRelease = yield* createRelease(fs, path, versionsRoot, '4.0.2', 'new');
          const testSystem = installationTestSystem(baseSystem, installRoot, oldRelease);
          yield* activateStandaloneRelease(oldRelease, false).pipe(Effect.provideService(SystemInfo, testSystem));
          const interrupted = yield* activateStandaloneRelease(newRelease, false, {
            afterStep: step =>
              step === 'active-previous-backed-up'
                ? Effect.fail(new Error('simulated active pointer crash'))
                : Effect.void,
          }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.flip);
          const activeMissingAfterCrash = !(yield* fs.exists(path.join(installRoot, 'active-release.json')));

          yield* activateStandaloneRelease(newRelease, false).pipe(Effect.provideService(SystemInfo, testSystem));
          return {
            active: JSON.parse(yield* fs.readFileString(path.join(installRoot, 'active-release.json'))) as {
              version: string;
            },
            activeMissingAfterCrash,
            backupExists: yield* fs.exists(path.join(installRoot, 'active-release.previous.json')),
            interrupted: String(interrupted),
            journalExists: yield* fs.exists(path.join(installRoot, 'active-release.promotion.json')),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toMatchObject({
      active: {version: '4.0.2'},
      activeMissingAfterCrash: true,
      backupExists: false,
      journalExists: false,
    });
    expect(result.interrupted).toContain('simulated active pointer crash');
  });

  it('commits an interrupted active-pointer promotion during installation-lock recovery', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-active-commit-recovery-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const versionsRoot = path.join(installRoot, 'versions');
          const oldRelease = yield* createRelease(fs, path, versionsRoot, '4.0.1', 'old');
          const newRelease = yield* createRelease(fs, path, versionsRoot, '4.0.2', 'new');
          const testSystem = installationTestSystem(baseSystem, installRoot, oldRelease);
          yield* activateStandaloneRelease(oldRelease, false).pipe(Effect.provideService(SystemInfo, testSystem));
          yield* activateStandaloneRelease(newRelease, false, {
            afterStep: step =>
              step === 'active-promoted'
                ? Effect.fail(new Error('simulated crash after pointer promotion'))
                : Effect.void,
          }).pipe(Effect.provideService(SystemInfo, testSystem), Effect.flip);

          yield* withStandaloneInstallationLock(Effect.void).pipe(Effect.provideService(SystemInfo, testSystem));
          return {
            active: JSON.parse(yield* fs.readFileString(path.join(installRoot, 'active-release.json'))) as {
              version: string;
            },
            backupExists: yield* fs.exists(path.join(installRoot, 'active-release.previous.json')),
            journalExists: yield* fs.exists(path.join(installRoot, 'active-release.promotion.json')),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      active: {releaseRoot: expect.any(String), version: '4.0.2'},
      backupExists: false,
      journalExists: false,
    });
  });

  it.each([
    {expected: 'old', step: 'release-journaled' as const},
    {expected: 'old', step: 'release-previous-backed-up' as const},
    {expected: 'new', step: 'release-promoted' as const},
  ])('recovers release directory promotion interrupted after $step', async ({expected, step}) => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-release-recovery-'});
          const versionsRoot = path.join(temporaryRoot, 'versions');
          const releaseRoot = yield* createRelease(fs, path, versionsRoot, '4.0.2', 'old');
          const stagingContainer = path.join(versionsRoot, '.threadnote-update-fixture');
          const stagedRoot = path.join(stagingContainer, 'release');
          yield* fs.makeDirectory(stagedRoot, {recursive: true});
          yield* fs.writeFileString(path.join(stagedRoot, 'marker.txt'), 'new\n');
          yield* fs.writeFileString(path.join(stagedRoot, 'release.json'), '{"version":"4.0.2"}\n');
          yield* promoteStandaloneReleaseDirectory(fs, path, stagedRoot, releaseRoot, system.processId, {
            afterStep: observed =>
              observed === step ? Effect.fail(new Error(`simulated crash after ${step}`)) : Effect.void,
          }).pipe(Effect.flip);

          yield* recoverStandaloneReleasePromotion(fs, path, releaseRoot);
          return {
            backupExists: yield* fs.exists(path.join(versionsRoot, '.4.0.2.promotion-backup')),
            journalExists: yield* fs.exists(path.join(versionsRoot, '.4.0.2.promotion.json')),
            marker: yield* fs.readFileString(path.join(releaseRoot, 'marker.txt')),
            stagedExists: yield* fs.exists(stagedRoot),
            stagingContainerExists: yield* fs.exists(stagingContainer),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      backupExists: false,
      journalExists: false,
      marker: `${expected}\n`,
      stagedExists: false,
      stagingContainerExists: false,
    });
  });

  it('uses semantic version precedence when choosing the retained rollback release', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-installations-semver-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const versionsRoot = path.join(installRoot, 'versions');
          for (const version of ['4.0.0', '4.1.0-beta.9', '4.1.0']) {
            const releaseRoot = path.join(versionsRoot, version);
            yield* fs.makeDirectory(releaseRoot, {recursive: true});
            yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), `${JSON.stringify({version})}\n`);
          }
          const activeRelease = path.join(versionsRoot, '4.0.0');
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
            executablePath: path.join(temporaryRoot, 'development-threadnote'),
          });

          yield* pruneStandaloneReleases(activeRelease, false).pipe(Effect.provideService(SystemInfo, testSystem));
          return {
            activeExists: yield* fs.exists(activeRelease),
            betaExists: yield* fs.exists(path.join(versionsRoot, '4.1.0-beta.9')),
            stableExists: yield* fs.exists(path.join(versionsRoot, '4.1.0')),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      activeExists: true,
      betaExists: false,
      stableExists: true,
    });
  });

  it('aborts stale pruning when another updater has activated a newer release', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-installations-stale-prune-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const versionsRoot = path.join(installRoot, 'versions');
          for (const version of ['4.0.0', '4.0.1', '4.0.2']) {
            const releaseRoot = path.join(versionsRoot, version);
            yield* fs.makeDirectory(releaseRoot, {recursive: true});
            yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), `${JSON.stringify({version})}\n`);
          }
          const staleActiveRelease = path.join(versionsRoot, '4.0.1');
          const currentActiveRelease = path.join(versionsRoot, '4.0.2');
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
            executablePath: path.join(versionsRoot, '4.0.0', 'threadnote'),
          });

          yield* activateStandaloneRelease(currentActiveRelease, false).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          yield* pruneStandaloneReleases(staleActiveRelease, false).pipe(Effect.provideService(SystemInfo, testSystem));
          return {
            currentExists: yield* fs.exists(currentActiveRelease),
            oldestExists: yield* fs.exists(path.join(versionsRoot, '4.0.0')),
            staleExists: yield* fs.exists(staleActiveRelease),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      currentExists: true,
      oldestExists: true,
      staleExists: true,
    });
  });

  it('retires verified superseded process trees without signaling the active release', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-process-retirement-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const rootProcessId = 40_001;
          const childProcessId = 40_002;
          const activeProcessId = 40_003;
          yield* writeProcessLease(fs, path, installRoot, '4.0.0', rootProcessId, 'root-process');
          yield* writeProcessLease(fs, path, installRoot, '4.0.0', childProcessId, 'child-process', rootProcessId);
          yield* writeProcessLease(fs, path, installRoot, '4.0.1', activeProcessId, 'active-process');
          const running = new Set([rootProcessId, childProcessId, activeProcessId]);
          const signals: Array<readonly [number, NodeJS.Signals]> = [];
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
            isProcessRunning: processId => running.has(processId),
            processId: 99_999,
            processStartIdentity: processId =>
              Effect.succeed(
                processId === rootProcessId
                  ? 'root-process'
                  : processId === childProcessId
                    ? 'child-process'
                    : processId === activeProcessId
                      ? 'active-process'
                      : undefined,
              ),
            signalProcess: (processId, signal) => {
              signals.push([processId, signal]);
              running.delete(processId);
            },
          });

          const termination = yield* terminateSupersededStandaloneProcesses('4.0.1', {
            gracefulWaitMilliseconds: 0,
          }).pipe(Effect.provideService(SystemInfo, testSystem));
          return {activeStillRunning: running.has(activeProcessId), signals, termination};
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.signals).toEqual([
      [40_001, 'SIGTERM'],
      [40_002, 'SIGTERM'],
    ]);
    expect(result.activeStillRunning).toBe(true);
    expect(result.termination.signaled.map(lease => lease.processId)).toEqual([40_001, 40_002]);
    expect(result.termination.remaining).toEqual([]);
    expect(result.termination.skippedUnverified).toEqual([]);
  });

  it('does not signal a superseded lease when the process identity changes after scanning', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-process-race-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const processId = 41_001;
          yield* writeProcessLease(fs, path, installRoot, '4.0.0', processId, 'original-process');
          let identityReads = 0;
          const signals: Array<readonly [number, NodeJS.Signals]> = [];
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
            isProcessRunning: candidate => candidate === processId,
            processId: 99_999,
            processStartIdentity: () =>
              Effect.sync(() => {
                identityReads += 1;
                return identityReads === 1 ? 'original-process' : 'replacement-process';
              }),
            signalProcess: (candidate, signal) => {
              signals.push([candidate, signal]);
            },
          });

          const termination = yield* terminateSupersededStandaloneProcesses('4.0.1', {
            gracefulWaitMilliseconds: 0,
          }).pipe(Effect.provideService(SystemInfo, testSystem));
          return {signals, termination};
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.signals).toEqual([]);
    expect(result.termination.signaled).toEqual([]);
    expect(result.termination.remaining.map(lease => lease.processId)).toEqual([41_001]);
  });

  it('reports but never signals superseded leases without verifiable process identity', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-process-unverified-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const processId = 42_001;
          yield* writeProcessLease(fs, path, installRoot, '4.0.0', processId);
          const signals: Array<readonly [number, NodeJS.Signals]> = [];
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
            isProcessRunning: candidate => candidate === processId,
            processId: 99_999,
            processStartIdentity: () => Effect.succeed(undefined),
            signalProcess: (candidate, signal) => {
              signals.push([candidate, signal]);
            },
          });

          const termination = yield* terminateSupersededStandaloneProcesses('4.0.1', {
            gracefulWaitMilliseconds: 0,
          }).pipe(Effect.provideService(SystemInfo, testSystem));
          return {signals, termination};
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.signals).toEqual([]);
    expect(result.termination.remaining).toEqual([]);
    expect(result.termination.skippedUnverified.map(lease => lease.processId)).toEqual([42_001]);
  });

  it('fails closed on malformed live leases and retains every release while inspection is incomplete', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-process-incomplete-'});
          const installRoot = path.join(root, 'install');
          const versionsRoot = path.join(installRoot, 'versions');
          for (const version of ['4.0.0', '4.0.1', '4.0.2']) {
            const releaseRoot = path.join(versionsRoot, version);
            yield* fs.makeDirectory(releaseRoot, {recursive: true});
            yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), `${JSON.stringify({version})}\n`);
          }
          const processId = 43_001;
          const leaseRoot = path.join(installRoot, 'leases', '4.0.0');
          yield* fs.makeDirectory(leaseRoot, {recursive: true});
          yield* fs.writeFileString(path.join(leaseRoot, `${processId}.json`), '{malformed');
          yield* fs.makeDirectory(path.join(installRoot, 'leases', 'unexpected-directory'));
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
            executablePath: path.join(versionsRoot, '4.0.1', 'threadnote'),
            isProcessRunning: candidate => candidate === processId,
            processId: 99_999,
          });
          const verification = yield* readStandaloneProcessLeaseVerification().pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          const terminationFailure = yield* terminateSupersededStandaloneProcesses('4.0.2').pipe(
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
          const pruning = yield* pruneStandaloneReleases(path.join(versionsRoot, '4.0.2'), false).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          return {
            pruning,
            staleReleaseExists: yield* fs.exists(path.join(versionsRoot, '4.0.0')),
            terminationFailure: String(terminationFailure),
            verification,
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.verification).toEqual({truncated: true, unverified: [], verified: []});
    expect(result.terminationFailure).toContain('inspection was incomplete');
    expect(result.pruning.complete).toBe(false);
    expect(result.staleReleaseExists).toBe(true);
  });
});

function createRelease(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionsRoot: string,
  version: string,
  marker: string,
) {
  return Effect.gen(function* () {
    const releaseRoot = path.join(versionsRoot, version);
    yield* fs.makeDirectory(releaseRoot, {recursive: true});
    yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), `${JSON.stringify({version})}\n`);
    yield* fs.writeFileString(path.join(releaseRoot, 'marker.txt'), `${marker}\n`);
    return releaseRoot;
  });
}

function installationTestSystem(baseSystem: SystemInfoShape, installRoot: string, runningRelease: string) {
  return SystemInfo.of({
    ...baseSystem,
    environment: () => ({
      ...baseSystem.environment(),
      THREADNOTE_INSTALL_ROOT: installRoot,
    }),
    executablePath: `${runningRelease}/threadnote`,
  });
}

function writeProcessLease(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  installRoot: string,
  version: string,
  processId: number,
  processStartIdentity?: string,
  parentProcessId?: number,
) {
  const leaseRoot = path.join(installRoot, 'leases', version);
  return Effect.gen(function* () {
    yield* fs.makeDirectory(leaseRoot, {recursive: true});
    yield* fs.writeFileString(
      path.join(leaseRoot, `${processId}.json`),
      `${JSON.stringify({
        parentProcessId,
        processId,
        processStartIdentity,
        startedAt: '2026-08-02T08:00:00.000Z',
        token: `lease-${processId}`,
        version,
      })}\n`,
    );
  });
}
