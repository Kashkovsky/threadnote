import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  commandLauncherPath,
  commandShimCheck,
  installCommandShim,
  managedCommandLauncherKinds,
  primaryCommandLauncherKind,
  removeCommandShim,
  renderCommandShim,
} from '../../src/command-shim.js';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo, type SystemInfoShape} from '../../src/effect/system.js';

describe('Windows Git Bash command launchers', () => {
  effectIt.effect('installs cmd and extensionless POSIX launchers for CLI and MCP on Windows', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap(fs => fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shims-'})),
        );
        const {releaseRoot, testSystem} = yield* windowsShimFixture(root);
        const installed = yield* captureConsole(installCommandShim(false, releaseRoot)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(managedCommandLauncherKinds('win32')).toEqual(['cmd', 'posix']);
        expect(managedCommandLauncherKinds('linux')).toEqual(['posix']);
        expect(managedCommandLauncherKinds('darwin')).toEqual(['posix']);
        expect(primaryCommandLauncherKind('win32')).toBe('cmd');
        expect(primaryCommandLauncherKind('linux')).toBe('posix');
        expect(primaryCommandLauncherKind('darwin')).toBe('posix');
        expect(yield* commandLauncherPath('cli').pipe(Effect.provideService(SystemInfo, testSystem))).toMatch(
          /threadnote\.cmd$/,
        );
        expect(yield* commandLauncherPath('mcp').pipe(Effect.provideService(SystemInfo, testSystem))).toMatch(
          /threadnote-mcp-server\.cmd$/,
        );

        const files = {
          cliCmd: yield* readLauncher(testSystem, 'cli', 'cmd'),
          cliPosix: yield* readLauncher(testSystem, 'cli', 'posix'),
          mcpCmd: yield* readLauncher(testSystem, 'mcp', 'cmd'),
          mcpPosix: yield* readLauncher(testSystem, 'mcp', 'posix'),
        };
        expect(installed.output).toContain(`Wrote command launcher: ${files.cliCmd.path}`);
        expect(installed.output).toContain(`Wrote command launcher: ${files.cliPosix.path}`);
        expect(installed.output).toContain(`Wrote command launcher: ${files.mcpCmd.path}`);
        expect(installed.output).toContain(`Wrote command launcher: ${files.mcpPosix.path}`);
        expect(path.basename(files.cliPosix.path)).toBe('threadnote');
        expect(path.basename(files.mcpPosix.path)).toBe('threadnote-mcp-server');
        expect(files.cliCmd.content).toBe(yield* renderFor(testSystem, releaseRoot, 'cli', 'cmd'));
        expect(files.cliPosix.content).toBe(yield* renderFor(testSystem, releaseRoot, 'cli', 'posix'));
        expect(files.mcpCmd.content).toBe(yield* renderFor(testSystem, releaseRoot, 'mcp', 'cmd'));
        expect(files.mcpPosix.content).toBe(yield* renderFor(testSystem, releaseRoot, 'mcp', 'posix'));
        expect(files.cliPosix.content.startsWith('#!/usr/bin/env sh\n')).toBe(true);
        expect(files.cliPosix.content).toContain('THREADNOTE_CALLER_CWD="$PWD"');
        expect(files.cliPosix.content).toContain('export THREADNOTE_CALLER_CWD');
        expect(files.cliPosix.content).toContain('exec "$THREADNOTE_ENTRY" "$@"');
        expect(files.mcpPosix.content).toContain('exec "$THREADNOTE_ENTRY" mcp-broker "$@"');
        expect(files.cliCmd.content.startsWith('@echo off\r\n')).toBe(true);
        expect(files.cliCmd.content).toContain('%*');

        const repeat = yield* captureConsole(installCommandShim(false, releaseRoot)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(repeat.output).toContain(`Command launcher already current: ${files.cliPosix.path}`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('doctor warns when the Git Bash launcher is missing beside a current cmd launcher', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-doctor-'});
        const {testSystem} = yield* windowsShimFixture(root);
        const cmdPath = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.writeFileString(
          cmdPath,
          yield* renderCommandShim(undefined, 'cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem)),
          {mode: 0o755},
        );

        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('warn');
        expect(check.detail).toBe(`${posixPath} missing; repair will create it`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('doctor warns when the cmd launcher is missing beside a current Git Bash launcher', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-doctor-cmd-'});
        const {testSystem} = yield* windowsShimFixture(root);
        const cmdPath = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.writeFileString(
          posixPath,
          yield* renderCommandShim(undefined, 'cli', 'posix').pipe(Effect.provideService(SystemInfo, testSystem)),
          {mode: 0o755},
        );

        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('warn');
        expect(check.detail).toBe(`${cmdPath} missing; repair will create it`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('doctor warns when the Git Bash launcher points at a different standalone release', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-stale-'});
        const {testSystem} = yield* windowsShimFixture(root);
        const cmdPath = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.writeFileString(
          cmdPath,
          yield* renderCommandShim(undefined, 'cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem)),
          {mode: 0o755},
        );
        yield* fs.writeFileString(
          posixPath,
          yield* renderCommandShim(path.join(root, 'stale-release'), 'cli', 'posix').pipe(
            Effect.provideService(SystemInfo, testSystem),
          ),
          {mode: 0o755},
        );

        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('warn');
        expect(check.detail).toBe(`${posixPath} points at a different standalone release; repair will rewrite it`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('doctor reports all Windows CLI and MCP launchers current after a default install', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap(fs => fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-doctor-ok-'})),
        );
        const {testSystem} = yield* windowsShimFixture(root);
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        const cliCmd = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const cliPosix = yield* commandLauncherPath('cli', 'posix').pipe(Effect.provideService(SystemInfo, testSystem));
        const mcpCmd = yield* commandLauncherPath('mcp', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const mcpPosix = yield* commandLauncherPath('mcp', 'posix').pipe(Effect.provideService(SystemInfo, testSystem));
        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('ok');
        expect(check.detail).toBe(`${cliCmd}; ${cliPosix}; ${mcpCmd}; ${mcpPosix}`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('doctor warns when the Git Bash MCP launcher is missing beside current CLI launchers', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-doctor-mcp-'});
        const {testSystem} = yield* windowsShimFixture(root);
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        const mcpPosix = yield* commandLauncherPath('mcp', 'posix').pipe(Effect.provideService(SystemInfo, testSystem));
        yield* fs.remove(mcpPosix);
        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('warn');
        expect(check.detail).toBe(`${mcpPosix} missing; repair will create it`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not overwrite an unmanaged Git Bash launcher and still writes the cmd launcher', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-unmanaged-'});
        const {releaseRoot, testSystem} = yield* windowsShimFixture(root);
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const unmanaged = '#!/usr/bin/env bash\necho "Generated by threadnote is documentation, not ownership"\n';
        yield* fs.writeFileString(posixPath, unmanaged, {mode: 0o755});

        const installed = yield* captureConsole(installCommandShim(false, releaseRoot)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(installed.output).toContain(`WARN not overwriting unmanaged command launcher: ${posixPath}`);
        expect(yield* fs.readFileString(posixPath)).toBe(unmanaged);
        const cmd = yield* readLauncher(testSystem, 'cli', 'cmd');
        expect(cmd.content).toBe(yield* renderFor(testSystem, releaseRoot, 'cli', 'cmd'));
        expect(path.basename(posixPath)).toBe('threadnote');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes a managed Git Bash launcher without touching an unmanaged cmd launcher', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-mixed-remove-'});
        const {releaseRoot, testSystem} = yield* windowsShimFixture(root);
        const cmdPath = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const unmanaged = '@echo off\r\necho unmanaged\r\n';
        yield* fs.writeFileString(cmdPath, unmanaged, {mode: 0o755});
        yield* installCommandShim(false, releaseRoot).pipe(Effect.provideService(SystemInfo, testSystem));
        const removed = yield* captureConsole(removeCommandShim(false)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(removed.output).toContain(`WARN not removing unmanaged command launcher: ${cmdPath}`);
        expect(yield* fs.readFileString(cmdPath)).toBe(unmanaged);
        expect(yield* fs.exists(posixPath)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes managed Windows cmd and POSIX launchers together', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-remove-'});
        const {releaseRoot, testSystem} = yield* windowsShimFixture(root);
        yield* installCommandShim(false, releaseRoot).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* removeCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        for (const mode of ['cli', 'mcp'] as const) {
          for (const kind of managedCommandLauncherKinds('win32')) {
            const launcher = yield* commandLauncherPath(mode, kind).pipe(Effect.provideService(SystemInfo, testSystem));
            expect(yield* fs.exists(launcher)).toBe(false);
          }
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'Windows POSIX shims are LF shebang scripts that exec the same release exe as the cmd launcher',
    {
      mode: fc.constantFrom('cli' as const, 'mcp' as const),
      variant: fc.constantFrom('plain' as const, 'spaced' as const),
      version: fc.stringMatching(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    },
    ({mode, variant, version}) =>
      Effect.gen(function* () {
        const baseSystem = yield* SystemInfo;
        const releaseRoot =
          variant === 'plain'
            ? `C:\\Threadnote\\versions\\${version}`
            : `C:\\Users\\John Doe\\Threadnote\\versions\\${version}`;
        const testSystem = SystemInfo.of({...baseSystem, platform: 'win32'});
        const [cmd, posix] = yield* Effect.all([
          renderCommandShim(releaseRoot, mode, 'cmd'),
          renderCommandShim(releaseRoot, mode, 'posix'),
        ]).pipe(Effect.provideService(SystemInfo, testSystem));
        const posixEntry = posixEntryPath(posix);
        const cmdEntry = cmdEntryPath(cmd);
        expect(cmd.includes('\r\n')).toBe(true);
        expect(posix.includes('\r')).toBe(false);
        expect(posix.includes('\\')).toBe(false);
        expect(posix.startsWith('#!/usr/bin/env sh\n')).toBe(true);
        expect(posix).toContain('THREADNOTE_CALLER_CWD="$PWD"');
        expect(posixEntry).toBe(cmdEntry.replaceAll('\\', '/'));
        expect(posixEntry).toContain(`/${version}/threadnote.exe`);
        expect(cmdEntry.replaceAll('\\', '/')).toContain(`/${version}/threadnote.exe`);
        if (variant === 'plain') {
          expect(posix).toContain(`THREADNOTE_ENTRY=C:/Threadnote/versions/${version}/threadnote.exe`);
        } else {
          expect(posix).toContain(`THREADNOTE_ENTRY='C:/Users/John Doe/Threadnote/versions/${version}/threadnote.exe'`);
        }
        expect(posix).toContain('exec "$THREADNOTE_ENTRY"');
        if (mode === 'mcp') {
          expect(posix).toContain('mcp-broker');
          expect(cmd).toContain('mcp-broker');
        } else {
          expect(posix).not.toContain('mcp-broker');
          expect(cmd).not.toContain('mcp-broker');
        }
      }).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 40}},
  );
});

const windowsShimFixture = Effect.fn('test.windowsShimFixture')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseSystem = yield* SystemInfo;
  const binDirectory = path.join(root, 'bin');
  const releaseRoot = path.join(root, 'versions', '4.6.3');
  yield* fs.makeDirectory(binDirectory, {recursive: true});
  const testSystem = SystemInfo.of({
    ...baseSystem,
    environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: binDirectory}),
    platform: 'win32',
  });
  return {binDirectory, releaseRoot, testSystem};
});

const renderFor = (testSystem: SystemInfoShape, releaseRoot: string, mode: 'cli' | 'mcp', kind: 'cmd' | 'posix') =>
  renderCommandShim(releaseRoot, mode, kind).pipe(Effect.provideService(SystemInfo, testSystem));

const readLauncher = Effect.fn('test.readLauncher')(function* (
  testSystem: SystemInfoShape,
  mode: 'cli' | 'mcp',
  kind: 'cmd' | 'posix',
) {
  const fs = yield* FileSystem.FileSystem;
  const launcherPath = yield* commandLauncherPath(mode, kind).pipe(Effect.provideService(SystemInfo, testSystem));
  return {content: yield* fs.readFileString(launcherPath), path: launcherPath};
});

function posixEntryPath(posix: string): string {
  const match = /^THREADNOTE_ENTRY=(.*)$/m.exec(posix);
  expect(match?.[1]).toEqual(expect.any(String));
  const raw = match?.[1] ?? '';
  return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replaceAll("'\"'\"'", "'") : raw;
}

function cmdEntryPath(cmd: string): string {
  const line = cmd.split(/\r?\n/u).find(candidate => candidate.includes('threadnote.exe'));
  expect(line).toEqual(expect.any(String));
  const match = /^"([^"]*)"/u.exec(line ?? '');
  expect(match?.[1]).toEqual(expect.any(String));
  return (match?.[1] ?? '').replaceAll('%%', '%').replaceAll('""', '"');
}
