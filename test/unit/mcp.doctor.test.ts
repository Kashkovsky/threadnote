import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {mcpConfigurationChecks} from '../../src/mcp.js';

describe('MCP doctor checks', () => {
  it.effect('reports a configured Codex MCP broker', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-doctor-'});
        const bin = path.join(root, 'bin');
        const codex = path.join(bin, 'codex');
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.writeFileString(
          codex,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 1"; exit 0; fi\nif [ "$1 $2 $3" = "mcp get threadnote" ]; then echo "command: /home/test/.local/bin/threadnote-mcp-server"; exit 0; fi\nexit 1\n',
        );
        yield* fs.chmod(codex, 0o755);
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), PATH: bin}),
          homeDirectory: path.join(root, 'user'),
        });

        const checks = yield* mcpConfigurationChecks().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(checks).toContainEqual({
          detail: 'threadnote broker configured',
          name: 'codex MCP',
          status: 'ok',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('warns when Codex and JSON hosts still invoke the direct MCP server', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-doctor-legacy-'});
        const bin = path.join(root, 'bin');
        const codex = path.join(bin, 'codex');
        const user = path.join(root, 'user');
        yield* fs.makeDirectory(path.join(user, '.cursor'), {recursive: true});
        yield* fs.makeDirectory(bin, {recursive: true});
        yield* fs.writeFileString(
          codex,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 1"; exit 0; fi\nif [ "$1 $2 $3" = "mcp get threadnote" ]; then echo "command: /home/test/.local/bin/threadnote\nargs: mcp-server"; exit 0; fi\nexit 1\n',
        );
        yield* fs.chmod(codex, 0o755);
        yield* fs.writeFileString(
          path.join(user, '.cursor', 'mcp.json'),
          JSON.stringify({
            mcpServers: {threadnote: {args: ['mcp-server'], command: '/home/test/.local/bin/threadnote'}},
          }),
        );
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), PATH: bin}),
          homeDirectory: user,
          platform: 'linux',
        });

        const checks = yield* mcpConfigurationChecks().pipe(Effect.provideService(SystemInfo, testSystem));
        for (const name of ['codex MCP', 'cursor MCP']) {
          expect(checks).toContainEqual({
            detail: expect.stringContaining('legacy direct server command'),
            name,
            status: 'warn',
          });
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('recognizes a Windows JSON host that launches the broker through ComSpec', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-doctor-windows-broker-'});
        const user = path.join(root, 'user');
        const cursorConfig = path.join(user, '.cursor', 'mcp.json');
        yield* fs.makeDirectory(path.dirname(cursorConfig), {recursive: true});
        yield* fs.writeFileString(
          cursorConfig,
          JSON.stringify({
            mcpServers: {
              threadnote: {
                args: ['/d', '/c', 'C:\\Threadnote\\bin\\threadnote-mcp-server.cmd'],
                command: 'C:\\Windows\\System32\\cmd.exe',
              },
            },
          }),
        );
        const testSystem = SystemInfo.of({...system, homeDirectory: user, platform: 'win32'});

        const checks = yield* mcpConfigurationChecks().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(checks).toContainEqual({
          detail: `threadnote broker configured in ${cursorConfig}`,
          name: 'cursor MCP',
          status: 'ok',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
