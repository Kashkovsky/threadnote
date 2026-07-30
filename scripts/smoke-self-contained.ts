import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Console, Effect, FileSystem, Layer, Option, Path} from 'effect';
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
    const invocationDirectory = path.join(temporaryRoot, 'repo');
    for (const directory of [threadnoteHome, userHome, invocationDirectory]) {
      yield* fs.makeDirectory(directory, {recursive: true});
    }
    const gitExecutable = Option.fromNullishOr(Bun.which('git'));
    if (Option.isNone(gitExecutable)) {
      return yield* Effect.fail(new Error('Standalone graph smoke requires Git on the build host.'));
    }
    yield* writePolyglotRepository(fs, path, invocationDirectory, gitExecutable.value);

    const environment: NodeJS.ProcessEnv = {
      HOME: userHome,
      LOCALAPPDATA: path.join(userHome, 'AppData', 'Local'),
      PATH: path.dirname(gitExecutable.value),
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

    const lexicalDatabase = path.join(threadnoteHome, 'indexes', 'lexical', 'active-v3.sqlite');
    const lexicalInfo = yield* fs.stat(lexicalDatabase);
    if (lexicalInfo.type !== 'File' || lexicalInfo.size <= 0) {
      return yield* Effect.fail(new Error('Standalone recall did not create a populated Bun SQLite index.'));
    }

    const doctor = yield* run(['doctor', '--dry-run']);
    if (!/bun runtime:\s+v1\.3\.14;\s+embedded/i.test(doctor) || /Node runtime/i.test(doctor)) {
      return yield* Effect.fail(new Error(`Doctor did not report the embedded Bun runtime:\n${doctor}`));
    }

    const indexed = yield* run(['graph', 'index']);
    if (!/14 symbols|symbols/i.test(indexed)) {
      return yield* Effect.fail(new Error(`Standalone graph index did not complete:\n${indexed}`));
    }
    const graphOperations = yield* Effect.all(
      [
        run(['graph', 'query', '--query', 'Greeter', '--json']),
        run(['graph', 'explain', '--symbol', 'KotlinApp', '--json']),
        run(['graph', 'path', '--from', 'typescriptBoot', '--to', 'typescriptHelper', '--json']),
        run(['graph', 'impact', '--query', 'makeService', '--json']),
      ],
      {concurrency: 1},
    );
    for (const [index, expected] of ['java', 'KotlinApp', 'typescriptHelper', 'swiftBoot'].entries()) {
      if (!graphOperations[index]!.includes(expected)) {
        return yield* Effect.fail(
          new Error(`Standalone graph operation ${index + 1} missed ${expected}:\n${graphOperations[index]}`),
        );
      }
    }

    yield* verifyMcp(executable, invocationDirectory, environment);
    yield* Console.log(
      'Self-contained Bun executable smoke passed with polyglot CLI/MCP graph operations and Node/Bun absent from PATH.',
    );
  }),
);

const writePolyglotRepository = Effect.fn('smokeSelfContained.writePolyglotRepository')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  gitExecutable: string,
) {
  const files: Readonly<Record<string, string>> = {
    'Package.swift': [
      'import PackageDescription',
      'let package = Package(name: "SwiftWorkspace", targets: [',
      '  .target(name: "SwiftCore"),',
      '  .target(name: "SwiftApp", dependencies: ["SwiftCore"])',
      '])',
      '',
    ].join('\n'),
    'Sources/SwiftApp/Main.swift': 'import SwiftCore\npublic func swiftBoot() -> String { makeService() }\n',
    'Sources/SwiftCore/Service.swift': 'public func makeService() -> String { "ready" }\n',
    'app/build.gradle.kts': 'dependencies { implementation(project(":shared")) }\n',
    'app/src/main/kotlin/com/acme/KotlinApp.kt':
      'package com.acme\nimport com.acme.Greeter\nclass KotlinApp { fun start() = Greeter() }\n',
    'settings.gradle.kts': 'include(":shared", ":app")\n',
    'shared/build.gradle.kts': '',
    'shared/src/main/java/com/acme/Greeter.java': 'package com.acme; public class Greeter { public Greeter() {} }\n',
    'src/helper.ts': 'export function typescriptHelper(): string { return "ready"; }\n',
    'src/main.ts':
      'import {typescriptHelper} from "./helper.js";\nexport function typescriptBoot() { return typescriptHelper(); }\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    yield* fs.makeDirectory(path.dirname(target), {recursive: true});
    yield* fs.writeFileString(target, content);
  }
  const git = (arguments_: readonly string[]) =>
    runCommandEffect(gitExecutable, arguments_, {
      cwd: root,
      maxOutputBytes: 128 * 1024,
      timeoutMs: 30_000,
    });
  yield* git(['init', '-q']);
  yield* git(['config', 'user.email', 'threadnote@example.test']);
  yield* git(['config', 'user.name', 'Threadnote Test']);
  yield* git(['add', '.']);
  yield* git(['commit', '-qm', 'polyglot standalone fixture']);
});

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
          if (!tools.tools.some(tool => tool.name === 'inspect_code_graph')) {
            throw new Error('Standalone MCP server did not expose inspect_code_graph.');
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
          const graphOperations = [
            {arguments: {callerCwd: cwd, operation: 'query', query: 'Greeter'}, expected: 'Greeter'},
            {arguments: {callerCwd: cwd, operation: 'explain', symbol: 'KotlinApp'}, expected: 'KotlinApp'},
            {
              arguments: {
                callerCwd: cwd,
                from: 'typescriptBoot',
                operation: 'path',
                to: 'typescriptHelper',
              },
              expected: 'typescriptHelper',
            },
            {
              arguments: {callerCwd: cwd, operation: 'impact', query: 'makeService'},
              expected: 'swiftBoot',
            },
          ] as const;
          for (const graph of graphOperations) {
            const inspected = await client.callTool(
              {arguments: graph.arguments, name: 'inspect_code_graph'},
              undefined,
              {timeout: COMMAND_TIMEOUT_MILLISECONDS},
            );
            const graphText = (inspected.content ?? []).map(item => ('text' in item ? item.text : '')).join('\n');
            if (inspected.isError === true || !graphText.includes(graph.expected)) {
              throw new Error(`Standalone MCP graph inspection missed ${graph.expected}:\n${graphText}`);
            }
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
