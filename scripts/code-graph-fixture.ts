import {Effect, FileSystem, Path} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';

export interface PreparedCodeGraphFixture {
  readonly home: string;
  readonly repository: string;
  readonly root: string;
}

export const GENERATED_VECTOR_CONTROL_PATH = 'docs/vector-semantic-control.md';
export const VECTOR_SEMANTIC_CONTROL_QUERY = 'serialize concurrent tasks via mutual exclusion';

export const prepareCodeGraphFixture = Effect.fn('codeGraphFixture.prepare')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* path.fromFileUrl(
    new URL('../test/evaluation/fixtures/code-graph-v1/repository/', import.meta.url),
  );
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-evaluation-'});
  const repository = path.join(root, 'repository');
  const home = path.join(root, 'home');
  yield* fs.copy(source, repository, {overwrite: true});
  yield* fs.makeDirectory(home, {recursive: true, mode: 0o700});
  yield* git(repository, ['init', '-q']);
  yield* git(repository, ['add', '.']);
  yield* git(repository, [
    '-c',
    'user.name=Threadnote Evaluation',
    '-c',
    'user.email=evaluation@threadnote.local',
    'commit',
    '-qm',
    'reviewed fixture',
  ]);
  return {home, repository, root} satisfies PreparedCodeGraphFixture;
});

export const prepareGeneratedCodeGraphFixture = Effect.fn('codeGraphFixture.prepareGenerated')(function* (
  targetSymbols: number,
  includeVectorControl = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!Number.isSafeInteger(targetSymbols) || targetSymbols < 1) {
    return yield* Effect.fail(new Error('Generated code graph target must be a positive safe integer.'));
  }
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-scale-'});
  const repository = path.join(root, 'repository');
  const source = path.join(repository, 'src');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(source, {recursive: true});
  yield* fs.makeDirectory(home, {recursive: true, mode: 0o700});
  yield* fs.writeFileString(
    path.join(repository, 'package.json'),
    `${JSON.stringify({name: '@threadnote/code-graph-scale', private: true, version: '1.0.0'}, undefined, 2)}\n`,
  );
  yield* fs.writeFileString(
    path.join(repository, 'tsconfig.json'),
    `${JSON.stringify({compilerOptions: {strict: true}, include: ['src/**/*.ts']}, undefined, 2)}\n`,
  );
  if (includeVectorControl) {
    yield* fs.makeDirectory(path.join(repository, 'docs'), {recursive: true});
    yield* fs.writeFileString(
      path.join(repository, GENERATED_VECTOR_CONTROL_PATH),
      '# Fixture architecture\n\n' +
        'The application calls the search package. Search serializes recall and vector-index activation through the core\n' +
        'exclusive file-lock contract. Lock recovery must preserve the previous ready index.\n',
    );
  }
  const symbolsPerFile = 100;
  const fileCount = Math.ceil(targetSymbols / symbolsPerFile);
  yield* Effect.forEach(
    Array.from({length: fileCount}, (_, index) => index),
    fileIndex => {
      const first = fileIndex * symbolsPerFile;
      const count = Math.min(symbolsPerFile, targetSymbols - first);
      const declarations = Array.from({length: count}, (_, offset) => {
        const symbolIndex = first + offset;
        const name = generatedSymbolName(symbolIndex);
        const body =
          symbolIndex === 0 ? `return ${symbolIndex};` : `return ${generatedSymbolName(symbolIndex - 1)}() + 1;`;
        return `export function ${name}(): number { ${body} }`;
      });
      return fs.writeFileString(
        path.join(source, `module-${String(fileIndex).padStart(5, '0')}.ts`),
        `${declarations.join('\n')}\n`,
      );
    },
    {concurrency: 16, discard: true},
  );
  yield* git(repository, ['init', '-q']);
  yield* git(repository, ['add', '.']);
  yield* git(repository, [
    '-c',
    'user.name=Threadnote Evaluation',
    '-c',
    'user.email=evaluation@threadnote.local',
    'commit',
    '-qm',
    `generated ${targetSymbols} symbol fixture`,
  ]);
  return {home, repository, root} satisfies PreparedCodeGraphFixture;
});

export function generatedSymbolName(index: number): string {
  return `scaleSymbol${String(index).padStart(6, '0')}`;
}

export const git = Effect.fn('codeGraphFixture.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {
    maxOutputBytes: 16 * 1_048_576,
    timeoutMs: 30_000,
  }),
);
