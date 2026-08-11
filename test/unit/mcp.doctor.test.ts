import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {mcpConfigurationChecks} from '../../src/mcp.js';

describe('MCP doctor checks', () => {
  it.effect('reports a configured Codex MCP server', () =>
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
          '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 1"; exit 0; fi\nif [ "$1 $2 $3" = "mcp get threadnote" ]; then echo "threadnote configured"; exit 0; fi\nexit 1\n',
        );
        yield* fs.chmod(codex, 0o755);
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), PATH: bin}),
          homeDirectory: path.join(root, 'user'),
        });

        const checks = yield* mcpConfigurationChecks().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(checks).toContainEqual({
          detail: 'threadnote server configured',
          name: 'codex MCP',
          status: 'ok',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
