import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {TestClock} from 'effect/testing';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {runMcpInstall} from '../../src/mcp/index.js';
import {
  DEFAULT_MCP_TOOLSET,
  isCursorCloudPersonalToolset,
  mcpToolCapabilities,
  parseMcpToolset,
  type McpToolset,
} from '../../src/mcp/toolset.js';
import {runRecall, runRemember} from '../../src/memory/index.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const PERSONAL_STDIO_TOOLSETS = ['core', 'full'] as const satisfies readonly McpToolset[];

const PERSONAL_STDIO_CAPABILITIES = {
  graphLocal: true,
  memoryPublish: true,
  memoryRead: true,
  memoryWrite: true,
} as const;

function runtime(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'tester',
  };
}

describe('shared-first local personal floor', () => {
  effectIt.effect('defaults stdio MCP to core without a remote memory endpoint', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-local-floor-mcp-'});
        expect(DEFAULT_MCP_TOOLSET).toBe('core');
        const output = yield* captureConsole(runMcpInstall(runtime(home), 'codex', {})).pipe(
          Effect.map(result => result.output),
        );
        expect(output).toContain('THREADNOTE_MCP_TOOLSET=core');
        expect(output).not.toContain('THREADNOTE_CURSOR_MEMORY_ENDPOINT');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'personal stdio toolsets keep local graph and Git-publishable memory',
    {toolset: FC.constantFrom(...PERSONAL_STDIO_TOOLSETS)},
    ({toolset}) =>
      Effect.sync(() => {
        const capabilities = mcpToolCapabilities(parseMcpToolset(toolset));
        expect(isCursorCloudPersonalToolset(toolset)).toBe(false);
        expect(capabilities).toEqual(expect.objectContaining(PERSONAL_STDIO_CAPABILITIES));
      }),
  );

  effectIt.effect('keeps Cursor Cloud local graph-only and independent of personal namespaces', () =>
    Effect.sync(() => {
      expect(mcpToolCapabilities(parseMcpToolset('cursor-cloud-local'))).toEqual({
        contextBrief: false,
        graphLocal: true,
        graphWorkset: false,
        maintenance: false,
        memoryPublish: false,
        memoryRead: false,
        memoryReview: false,
        memoryWrite: false,
      });
    }),
  );

  effectIt.effect('remembers and recalls locally when the cloud memory endpoint is unreachable', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-local-floor-memory-'});
        yield* fs.writeFileString(path.join(home, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
        const config = runtime(home);
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({
            ...system.environment(),
            THREADNOTE_CURSOR_MEMORY_ENDPOINT: 'https://127.0.0.1:1/mcp',
            THREADNOTE_MCP_TOOLSET: 'core',
          }),
        });

        yield* TestClock.setTime(Date.parse('2026-09-04T12:00:00.000Z'));
        yield* runRemember(config, {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'test',
          text: 'Local personal floor remembers without a composer.',
          topic: 'local-personal-floor',
        }).pipe(Effect.provideService(SystemInfo, testSystem));

        const recall = yield* captureConsole(
          runRecall(config, {
            inferScope: false,
            query: 'Local personal floor remembers without a composer',
          }).pipe(Effect.provideService(SystemInfo, testSystem)),
        );
        expect(recall.output).toContain(
          'threadnote://user/tester/memories/durable/projects/threadnote/local-personal-floor.md',
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
