import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path} from 'effect';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly version?: string;
}

const ROOT_URL = new URL('..', import.meta.url);
const RELEASE_DIRECTORIES = ['config', 'docs', 'manager'] as const;
const RELEASE_FILES = ['.threadnoteignore', 'LICENSE', 'THIRD_PARTY.md'] as const;
const NATIVE_RUNTIME_PACKAGE = 'node-llama-cpp';
const OPTIONAL_NATIVE_PACKAGE = /^@node-llama-cpp\//;

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(ROOT_URL);
  const outputRoot = path.join(root, 'dist');
  const manifest = yield* readPackageManifest(fs, path.join(root, 'package.json'));
  const version = manifest.version;
  const nativeRuntimeVersion = manifest.dependencies?.[NATIVE_RUNTIME_PACKAGE];
  if (!version || !nativeRuntimeVersion) {
    return yield* Effect.fail(new Error('package.json must declare version and an exact node-llama-cpp dependency.'));
  }

  const target = buildTarget();
  assertNativeTargetMatchesHost(target);
  const executableName = target.includes('windows') ? 'threadnote.exe' : 'threadnote';
  const executablePath = path.join(outputRoot, executableName);

  yield* fs.makeDirectory(outputRoot, {recursive: true});
  for (const directory of RELEASE_DIRECTORIES) {
    yield* fs.copy(path.join(root, directory), path.join(outputRoot, directory), {overwrite: true});
  }
  for (const file of RELEASE_FILES) {
    yield* fs.copyFile(path.join(root, file), path.join(outputRoot, file));
  }

  yield* runBuild({
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
      outfile: executablePath,
      target,
    },
    define: {
      'process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED': JSON.stringify('true'),
      THREADNOTE_STANDALONE: 'true',
      THREADNOTE_VERSION: JSON.stringify(version),
    },
    bytecode: true,
    entrypoints: [path.join(root, 'src', 'standalone.ts')],
    format: 'esm',
    minify: true,
    sourcemap: 'linked',
    target: 'bun',
  });
  if (!target.includes('windows')) {
    yield* fs.chmod(executablePath, 0o755);
  }

  yield* runBuild({
    entrypoints: [path.join(root, 'src', 'manager_ui.tsx')],
    minify: true,
    naming: 'app.js',
    outdir: path.join(outputRoot, 'manager'),
    target: 'browser',
  });

  const nativeRuntimeRoot = path.join(outputRoot, 'runtime');
  const nativePackage = nativePackageForTarget(target);
  const nativePackageRoot = path.join(root, 'node_modules', ...nativePackage.split('/'));
  if (!(yield* fs.exists(nativePackageRoot))) {
    return yield* Effect.fail(
      new Error(`${nativePackage} is not installed on this target build host. Run bun install before building.`),
    );
  }
  yield* fs.makeDirectory(nativeRuntimeRoot, {recursive: true});
  yield* bundleNativeRuntime(
    path.join(root, 'node_modules', NATIVE_RUNTIME_PACKAGE, 'dist', 'index.js'),
    path.join(nativeRuntimeRoot, 'node-llama-cpp.js'),
    nativePackage,
    nativeRuntimeVersion,
  );
  yield* fs.copy(path.join(nativePackageRoot, 'bins'), path.join(nativeRuntimeRoot, 'native'), {overwrite: true});
  yield* fs.copyFile(path.join(nativePackageRoot, 'LICENSE'), path.join(nativeRuntimeRoot, 'NATIVE-LICENSE'));
  yield* fs.makeDirectory(path.join(outputRoot, 'llama'), {recursive: true});
  yield* fs.copyFile(
    path.join(root, 'node_modules', NATIVE_RUNTIME_PACKAGE, 'llama', 'binariesGithubRelease.json'),
    path.join(outputRoot, 'llama', 'binariesGithubRelease.json'),
  );
  yield* fs.writeFileString(
    path.join(outputRoot, 'release.json'),
    `${JSON.stringify(
      {
        executable: executableName,
        nativeRuntime: `runtime/${NATIVE_RUNTIME_PACKAGE}.js`,
        nativeRuntimePackage: nativePackage,
        runtime: `bun-${Bun.version}`,
        target,
        version,
      },
      null,
      2,
    )}\n`,
  );
  yield* Console.log(`Built standalone Threadnote ${version} for ${target}: ${executablePath}`);
});

function readPackageManifest(fs: FileSystem.FileSystem, path: string) {
  return fs.readFileString(path).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as PackageManifest,
        catch: cause => new Error('Could not parse package.json.', {cause}),
      }),
    ),
  );
}

function runBuild(options: Bun.BuildConfig) {
  return Effect.tryPromise({
    try: () => Bun.build(options),
    catch: cause => new Error('Bun could not build the standalone artifact.', {cause}),
  }).pipe(
    Effect.flatMap(result =>
      result.success
        ? Effect.void
        : Effect.fail(
            new Error(
              result.logs
                .map(log => log.message)
                .filter(Boolean)
                .join('\n'),
            ),
          ),
    ),
  );
}

function bundleNativeRuntime(entrypoint: string, outfile: string, nativePackage: string, nativeRuntimeVersion: string) {
  return runBuild({
    entrypoints: [entrypoint],
    minify: true,
    naming: outfile.replaceAll('\\', '/').split('/').at(-1),
    outdir: outfile.replace(/[\\/][^\\/]+$/, ''),
    plugins: [
      {
        name: 'threadnote-native-runtime',
        setup(builder) {
          builder.onResolve({filter: /getModuleVersion\.js$/}, () => ({
            namespace: 'threadnote-native-runtime-version',
            path: 'getModuleVersion',
          }));
          builder.onLoad({filter: /.*/, namespace: 'threadnote-native-runtime-version'}, () => ({
            contents: `export const getModuleVersion = async () => ${JSON.stringify(nativeRuntimeVersion)};`,
            loader: 'js',
          }));
          builder.onResolve({filter: OPTIONAL_NATIVE_PACKAGE}, args => ({
            namespace: 'threadnote-native-runtime',
            path: args.path,
          }));
          builder.onLoad({filter: /.*/, namespace: 'threadnote-native-runtime'}, args => ({
            contents:
              args.path === nativePackage
                ? [
                    `const binsDir = Bun.fileURLToPath(new URL('./native', import.meta.url));`,
                    `export const getBinsDir = () => ({binsDir, packageVersion: ${JSON.stringify(nativeRuntimeVersion)}});`,
                  ].join('\n')
                : `export const getBinsDir = () => { throw new Error(${JSON.stringify(
                    `${args.path} is not included in this ${nativePackage} Threadnote artifact.`,
                  )}); };`,
            loader: 'js',
          }));
        },
      },
    ],
    target: 'bun',
  });
}

function buildTarget(): Bun.Build.CompileTarget {
  const configured = Bun.env.THREADNOTE_BUILD_TARGET?.trim();
  if (configured) {
    return configured as Bun.Build.CompileTarget;
  }
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `bun-${platform}-${process.arch}` as Bun.Build.CompileTarget;
}

function assertNativeTargetMatchesHost(target: Bun.Build.CompileTarget): void {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const architecture = process.arch === 'arm64' ? '(?:arm64|aarch64)' : process.arch;
  const matchesHost = new RegExp(`^bun-${platform}-${architecture}(?:-|$)`).test(target);
  if (!matchesHost) {
    throw new Error(
      `Target ${target} does not match this ${platform}-${process.arch} build host. ` +
        'Native local-AI payloads must be assembled on their target OS and architecture.',
    );
  }
}

function nativePackageForTarget(target: Bun.Build.CompileTarget): string {
  if (target.startsWith('bun-darwin-arm64') || target.startsWith('bun-darwin-aarch64')) {
    return '@node-llama-cpp/mac-arm64-metal';
  }
  if (target.startsWith('bun-darwin-x64')) {
    return '@node-llama-cpp/mac-x64';
  }
  if (target.startsWith('bun-linux-arm64') || target.startsWith('bun-linux-aarch64')) {
    return '@node-llama-cpp/linux-arm64';
  }
  if (target.startsWith('bun-linux-x64')) {
    return '@node-llama-cpp/linux-x64';
  }
  if (target.startsWith('bun-windows-arm64') || target.startsWith('bun-windows-aarch64')) {
    return '@node-llama-cpp/win-arm64';
  }
  if (target.startsWith('bun-windows-x64')) {
    return '@node-llama-cpp/win-x64';
  }
  throw new Error(`No prebuilt native local-AI package is mapped for ${target}.`);
}

BunRuntime.runMain(build.pipe(Effect.provide(BunServices.layer)));
