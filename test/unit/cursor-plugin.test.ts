import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {USER_INSTRUCTIONS_END_MARKER, USER_INSTRUCTIONS_START_MARKER} from '../../src/constants.js';
import {cursorPluginDoctorChecks, installCursorPlugin, removeCursorPlugin} from '../../src/cursor-plugin.js';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';

const root = process.cwd();
const pluginRoot = join(root, 'cursor-plugin');

describe('Cursor plugin package', () => {
  it('matches Cursor manifest anatomy and the canonical Threadnote instructions', async () => {
    const [marketplaceRaw, manifestRaw, markerRaw, rule, instructions, pluginLicense, licenseScope, packageRaw] =
      await Promise.all([
        readFile(join(root, '.cursor-plugin', 'marketplace.json'), 'utf8'),
        readFile(join(pluginRoot, '.cursor-plugin', 'plugin.json'), 'utf8'),
        readFile(join(pluginRoot, '.threadnote-managed.json'), 'utf8'),
        readFile(join(pluginRoot, 'rules', 'threadnote.mdc'), 'utf8'),
        readFile(join(root, 'config', 'agent-instructions.md'), 'utf8'),
        readFile(join(pluginRoot, 'LICENSE'), 'utf8'),
        readFile(join(root, 'CURSOR_PLUGIN_LICENSE.md'), 'utf8'),
        readFile(join(root, 'package.json'), 'utf8'),
      ]);
    const marketplace = JSON.parse(marketplaceRaw) as Record<string, unknown>;
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;

    expect(Object.keys(marketplace).sort()).toEqual(['metadata', 'name', 'owner', 'plugins']);
    expect(marketplace).toMatchObject({
      name: 'threadnote',
      plugins: [
        {
          minClientVersions: {cursor: '2.5.0'},
          name: 'threadnote',
          source: 'cursor-plugin',
        },
      ],
    });
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'author',
        'category',
        'description',
        'displayName',
        'homepage',
        'keywords',
        'license',
        'logo',
        'minClientVersions',
        'name',
        'publisher',
        'repository',
        'rules',
        'tags',
        'version',
      ].sort(),
    );
    expect(manifest).toMatchObject({
      license: 'MIT',
      minClientVersions: {cursor: '2.5.0'},
      name: 'threadnote',
      rules: './rules/',
      version: '1.0.0',
    });
    expect(JSON.parse(markerRaw)).toEqual({managedBy: 'threadnote', schemaVersion: 1});
    expect(rule).toMatch(/^---\ndescription: .+\nalwaysApply: true\n---\n/);
    expect(rule).toContain(
      `${USER_INSTRUCTIONS_START_MARKER}\n${instructions.trim()}\n${USER_INSTRUCTIONS_END_MARKER}`,
    );
    expect(pluginLicense.startsWith('MIT License')).toBe(true);
    expect(licenseScope).toContain('`.cursor-plugin/` and `cursor-plugin/`');
    expect(JSON.parse(packageRaw)).toMatchObject({license: 'AGPL-3.0-or-later'});
  });

  it.effect('skips absent Cursor and verifies local and Marketplace plugin installs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cursor-plugin-'});
        const userHome = path.join(temporaryRoot, 'user');
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), PATH: ''}),
          homeDirectory: userHome,
        });

        const skipped = yield* cursorPluginDoctorChecks({cursorInstalled: false}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(skipped).toEqual([]);

        const missing = yield* cursorPluginDoctorChecks({cursorInstalled: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(missing).toMatchObject([{name: 'Cursor plugin', status: 'warn'}]);

        const localRoot = path.join(userHome, '.cursor', 'plugins', 'local', 'threadnote');
        yield* fs.copy(pluginRoot, localRoot, {overwrite: true});
        const local = yield* cursorPluginDoctorChecks({cursorInstalled: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(local).toMatchObject([{name: 'Cursor plugin', status: 'ok'}]);
        expect(local[0]?.detail).toContain('always-applied rule verified');

        const localManifest = path.join(localRoot, '.cursor-plugin', 'plugin.json');
        yield* fs.writeFileString(
          localManifest,
          (yield* fs.readFileString(localManifest)).replace('"version": "1.0.0"', '"version": "0.9.0"'),
        );
        const outdated = yield* cursorPluginDoctorChecks({cursorInstalled: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(outdated).toMatchObject([{name: 'Cursor plugin', status: 'warn'}]);
        expect(outdated[0]?.detail).toContain('is older than bundled v1.0.0');
        yield* fs.copy(pluginRoot, localRoot, {overwrite: true});

        const localRule = path.join(localRoot, 'rules', 'threadnote.mdc');
        yield* fs.writeFileString(localRule, (yield* fs.readFileString(localRule)).replace('alwaysApply: true', ''));
        const invalid = yield* cursorPluginDoctorChecks({cursorInstalled: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(invalid).toMatchObject([{name: 'Cursor plugin', status: 'fail'}]);

        yield* fs.remove(localRoot, {recursive: true});
        const cachedRoot = path.join(userHome, '.cursor', 'plugins', 'cache', 'threadnote', '1.0.0');
        yield* fs.copy(pluginRoot, cachedRoot, {overwrite: true});
        const cached = yield* cursorPluginDoctorChecks({cursorInstalled: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(cached).toMatchObject([{name: 'Cursor plugin', status: 'ok'}]);
        expect(cached[0]?.detail).toContain(cachedRoot);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('installs, refreshes, and removes only Threadnote-managed local plugins', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cursor-plugin-install-'});
        const userHome = path.join(temporaryRoot, 'user');
        const targetRoot = path.join(userHome, '.cursor', 'plugins', 'local', 'threadnote');
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});

        const dryRun = yield* captureConsole(installCursorPlugin(true, root, {cursorInstalled: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(dryRun.output).toContain(`Would install Cursor plugin: ${targetRoot}`);
        expect(yield* fs.exists(targetRoot)).toBe(false);

        const installed = yield* captureConsole(installCursorPlugin(false, root, {cursorInstalled: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(installed.output).toContain(`Installed Cursor plugin: ${targetRoot}`);
        expect(JSON.parse(yield* fs.readFileString(path.join(targetRoot, '.threadnote-managed.json')))).toEqual({
          managedBy: 'threadnote',
          schemaVersion: 1,
        });

        const targetRule = path.join(targetRoot, 'rules', 'threadnote.mdc');
        yield* fs.writeFileString(targetRule, 'tampered\n');
        const refreshed = yield* captureConsole(installCursorPlugin(false, root, {cursorInstalled: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(refreshed.output).toContain(`Refreshed managed Cursor plugin: ${targetRoot}`);
        expect(yield* fs.readFileString(targetRule)).toBe(
          yield* fs.readFileString(join(pluginRoot, 'rules', 'threadnote.mdc')),
        );

        const removed = yield* captureConsole(removeCursorPlugin(false)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(removed.output).toContain(`Removed managed Cursor plugin: ${targetRoot}`);
        expect(yield* fs.exists(targetRoot)).toBe(false);

        yield* fs.makeDirectory(targetRoot, {recursive: true});
        const sentinel = path.join(targetRoot, 'user-owned.txt');
        yield* fs.writeFileString(sentinel, 'preserve\n');
        const refusedInstall = yield* captureConsole(installCursorPlugin(false, root, {cursorInstalled: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(refusedInstall.output).toContain(`${targetRoot} is not managed by Threadnote; not modifying it`);
        const refusedRemoval = yield* captureConsole(removeCursorPlugin(false)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(refusedRemoval.output).toContain(`${targetRoot} is not managed by Threadnote; not removing it`);
        expect(yield* fs.readFileString(sentinel)).toBe('preserve\n');
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
