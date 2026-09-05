import {it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {runMcpInstall} from '../../src/mcp/index.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const runtime: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-test/seed-manifest.yaml',
  user: 'test-user',
};

it.effect.prop(
  'preserves semantically current JSON host configs across formatting, key order, and unrelated fields',
  {
    extraEnvironmentValue: FC.string({maxLength: 24}),
    extraFieldValue: FC.oneof(FC.boolean(), FC.integer(), FC.string({maxLength: 24})),
    indentation: FC.constantFrom(0, 1, 2, 4),
    reverseEntryOrder: FC.boolean(),
    reverseRootOrder: FC.boolean(),
  },
  ({extraEnvironmentValue, extraFieldValue, indentation, reverseEntryOrder, reverseRootOrder}) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-property-'});
        const user = path.join(root, 'user');
        const home = path.join(user, '.threadnote');
        const bin = path.join(root, 'bin');
        const broker = path.join(bin, 'threadnote-mcp-server');
        const configPath = path.join(user, '.cursor', 'mcp.json');
        const environment = {
          EXTRA_USER_VALUE: extraEnvironmentValue,
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_AGENT_ID: 'threadnote',
          THREADNOTE_HOME: home,
          THREADNOTE_MCP_CLIENT: 'cursor',
          THREADNOTE_MCP_TOOLSET: 'core',
          THREADNOTE_USER: 'test-user',
        };
        const testRuntime: RuntimeConfig = {
          ...runtime,
          agentContextHome: home,
          manifestPath: path.join(home, 'seed-manifest.yaml'),
        };
        const server = reverseEntryOrder
          ? {userMetadata: extraFieldValue, env: environment, args: [], command: broker}
          : {command: broker, args: [], env: environment, userMetadata: extraFieldValue};
        const servers = reverseEntryOrder
          ? {unrelated: {command: 'user-server'}, threadnote: server}
          : {threadnote: server, unrelated: {command: 'user-server'}};
        const config = reverseRootOrder
          ? {userSetting: extraFieldValue, mcpServers: servers}
          : {mcpServers: servers, userSetting: extraFieldValue};
        const original = JSON.stringify(config, null, indentation);
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
        yield* fs.writeFileString(configPath, original);

        yield* runMcpInstall(testRuntime, 'cursor', {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem));

        expect(yield* fs.readFileString(configPath)).toBe(original);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  {fastCheck: {numRuns: 40}},
);
