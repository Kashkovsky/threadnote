import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Console, Effect, FileSystem, Layer, Path} from 'effect';
import {CommandExecutor, runCommandEffect} from '../src/effect/command.js';
import {SystemInfo} from '../src/effect/system.js';

const ROOT_URL = new URL('..', import.meta.url);
const COMMAND_TIMEOUT_MILLISECONDS = 300_000;
const SMOKE_MARKER = 'QZ9-standalone-bun-smoke';

const smokeSelfContained = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(ROOT_URL);
    const executable = path.join(root, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote');
    if (!(yield* fs.exists(executable))) {
      return yield* Effect.fail(new Error('Standalone executable is missing; run bun run build first.'));
    }

    const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-standalone-smoke-'});
    const threadnoteHome = path.join(temporaryRoot, 'home');
    const userHome = path.join(temporaryRoot, 'user-home');
    const emptyPath = path.join(temporaryRoot, 'empty-path');
    const invocationDirectory = path.join(temporaryRoot, 'repo');
    for (const directory of [threadnoteHome, userHome, emptyPath, invocationDirectory]) {
      yield* fs.makeDirectory(directory, {recursive: true});
    }

    const environment: NodeJS.ProcessEnv = {
      HOME: userHome,
      LOCALAPPDATA: path.join(userHome, 'AppData', 'Local'),
      PATH: emptyPath,
      THREADNOTE_BIN_DIR: path.join(temporaryRoot, 'bin'),
      THREADNOTE_CALLER_CWD: invocationDirectory,
      THREADNOTE_HOME: threadnoteHome,
      THREADNOTE_USER: 'standalone-smoke',
      USER: 'standalone-smoke',
      USERPROFILE: userHome,
    };
    const run = (arguments_: readonly string[]) =>
      runCommandEffect(executable, arguments_, {
        cwd: invocationDirectory,
        env: environment,
        maxOutputBytes: 512 * 1024,
        timeoutMs: COMMAND_TIMEOUT_MILLISECONDS,
      }).pipe(Effect.map(result => `${result.stdout}\n${result.stderr}`));

    const version = yield* run(['--version']);
    if (!/threadnote v4\./.test(version)) {
      return yield* Effect.fail(new Error(`Standalone release reported an unexpected version:\n${version}`));
    }

    const runtime = yield* run(['models', 'runtime']);
    if (!/node-llama-cpp:\s+prebuilt/i.test(runtime)) {
      return yield* Effect.fail(new Error(`Native runtime was not loaded from the release payload:\n${runtime}`));
    }

    yield* run([
      'remember',
      '--kind',
      'durable',
      '--project',
      'threadnote',
      '--topic',
      'standalone-bun-smoke',
      '--text',
      `${SMOKE_MARKER} stores and recalls without Node or an external Bun installation.`,
    ]);
    const recall = yield* run(['recall', '--query', `${SMOKE_MARKER} standalone recall`]);
    if (!recall.includes('standalone-bun-smoke.md')) {
      return yield* Effect.fail(new Error(`Standalone lexical recall missed the stored memory:\n${recall}`));
    }

    const lexicalDatabase = path.join(threadnoteHome, 'indexes', 'lexical', 'active-v2.sqlite');
    const lexicalInfo = yield* fs.stat(lexicalDatabase);
    if (lexicalInfo.type !== 'File' || lexicalInfo.size <= 0) {
      return yield* Effect.fail(new Error('Standalone recall did not create a populated Bun SQLite index.'));
    }

    const doctor = yield* run(['doctor', '--dry-run']);
    if (!/bun runtime:\s+v1\.3\.14;\s+embedded/i.test(doctor) || /Node runtime/i.test(doctor)) {
      return yield* Effect.fail(new Error(`Doctor did not report the embedded Bun runtime:\n${doctor}`));
    }

    yield* verifyMcp(executable, invocationDirectory, environment);
    yield* Console.log('Self-contained Bun executable smoke passed with Node and Bun absent from PATH.');
  }),
);

const verifyMcp = Effect.fn('smokeSelfContained.verifyMcp')(function* (
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const transport = new StdioClientTransport({
    args: ['mcp-server'],
    command: executable,
    cwd,
    env: environment,
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-standalone-smoke', version: '1.0.0'});
  yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => client.connect(transport),
      catch: cause => new Error('Could not start the standalone MCP server.', {cause}),
    }),
    () =>
      Effect.tryPromise({
        try: async () => {
          const tools = await client.listTools();
          if (!tools.tools.some(tool => tool.name === 'recall_context')) {
            throw new Error('Standalone MCP server did not expose recall_context.');
          }
          const recalled = await client.callTool(
            {
              arguments: {
                query: `${SMOKE_MARKER} standalone recall`,
                threshold: 0.1,
                uri: 'threadnote://user/standalone-smoke/memories/durable/projects/threadnote',
              },
              name: 'recall_context',
            },
            undefined,
            {timeout: COMMAND_TIMEOUT_MILLISECONDS},
          );
          const text = (recalled.content ?? []).map(item => ('text' in item ? item.text : '')).join('\n');
          if (recalled.isError === true || !text.includes('standalone-bun-smoke.md')) {
            throw new Error(`Standalone MCP recall missed the stored memory:\n${text}`);
          }
        },
        catch: cause => (cause instanceof Error ? cause : new Error('Standalone MCP smoke failed.', {cause})),
      }),
    () =>
      Effect.tryPromise({
        try: () => client.close(),
        catch: cause => new Error('Could not close the standalone MCP smoke client.', {cause}),
      }).pipe(Effect.catch(() => Effect.void)),
  );
});

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const smokeLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

BunRuntime.runMain(smokeSelfContained.pipe(Effect.provide(smokeLayer)));
