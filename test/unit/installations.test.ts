import {Effect, FileSystem, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {SystemInfo} from '../../src/effect/system.js';
import {
  activateStandaloneRelease,
  activeInstalledVersion,
  pruneStandaloneReleases,
  withStandaloneInstallationLock,
} from '../../src/installations.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('standalone release lifecycle', () => {
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
});
