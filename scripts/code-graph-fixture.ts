import {Effect, FileSystem, Path} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';

export interface PreparedCodeGraphFixture {
  readonly home: string;
  readonly incrementalSourcePath?: string;
  readonly profile?: ProductionCodeGraphFixtureProfile;
  readonly queryText?: string;
  readonly repository: string;
  readonly root: string;
}

export interface ProductionCodeGraphFixtureProfile {
  readonly declarationSymbols: number;
  readonly id: 'production-large';
  readonly sourceFiles: number;
  readonly targetEligibleFiles: number;
  readonly targetGraphEdges: number;
  readonly targetGraphSymbols: number;
  readonly targetLexicalTermRows: number;
  readonly version: 1;
  readonly workspaceCount: number;
}

/**
 * Opt-in/nightly shape based on the beta.27 investigation repository. `declarationSymbols` deliberately excludes the
 * compiler-emitted file/module symbol so the resulting stored graph lands near `targetGraphSymbols`.
 */
export const PRODUCTION_LARGE_CODE_GRAPH_PROFILE = {
  declarationSymbols: 752_000,
  id: 'production-large',
  sourceFiles: 47_880,
  targetEligibleFiles: 48_000,
  targetGraphEdges: 2_700_000,
  targetGraphSymbols: 800_000,
  targetLexicalTermRows: 12_000_000,
  version: 1,
  workspaceCount: 24,
} as const satisfies ProductionCodeGraphFixtureProfile;

export const GENERATED_VECTOR_CONTROL_PATH = 'docs/vector-semantic-control.md';
export const VECTOR_SEMANTIC_CONTROL_QUERY = 'serialize concurrent tasks via mutual exclusion';

export const prepareCodeGraphFixture = Effect.fn('codeGraphFixture.prepare')(function* (fixture = 'code-graph-v1') {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!/^code-graph-[a-z0-9-]+$/.test(fixture)) {
    return yield* Effect.fail(new Error(`Invalid code graph fixture name: ${fixture}.`));
  }
  const source = yield* path.fromFileUrl(
    new URL(`../test/evaluation/fixtures/${fixture}/repository/`, import.meta.url),
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

export const prepareProductionCodeGraphFixture = Effect.fn('codeGraphFixture.prepareProduction')(function* (
  requested: ProductionCodeGraphFixtureProfile = PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
  includeVectorControl = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profile = validateProductionProfile(requested);
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-production-scale-'});
  const repository = path.join(root, 'repository');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(repository, {recursive: true});
  yield* fs.makeDirectory(home, {recursive: true, mode: 0o700});

  const workspaces = productionWorkspaceRoots(profile.workspaceCount);
  yield* fs.writeFileString(
    path.join(repository, 'package.json'),
    `${JSON.stringify(
      {
        name: '@threadnote/production-large-fixture',
        private: true,
        version: '1.0.0',
        workspaces: ['apps/*', 'apps/integrated/modules/*', 'libs/*', 'services/*', 'tools/*'],
      },
      undefined,
      2,
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(repository, 'tsconfig.json'),
    `${JSON.stringify(
      {
        files: [],
        references: workspaces.map(workspace => ({path: workspace})),
      },
      undefined,
      2,
    )}\n`,
  );

  yield* Effect.forEach(
    workspaces,
    (workspace, workspaceIndex) =>
      Effect.gen(function* () {
        const workspaceRoot = path.join(repository, workspace);
        yield* fs.makeDirectory(path.join(workspaceRoot, 'src'), {recursive: true});
        yield* fs.writeFileString(
          path.join(workspaceRoot, 'package.json'),
          `${JSON.stringify(
            {
              dependencies: workspaceIndex === 0 ? {} : {[productionPackageName(workspaceIndex - 1)]: 'workspace:*'},
              name: productionPackageName(workspaceIndex),
              private: true,
              version: '1.0.0',
            },
            undefined,
            2,
          )}\n`,
        );
        yield* fs.writeFileString(
          path.join(workspaceRoot, 'tsconfig.json'),
          `${JSON.stringify(
            {
              compilerOptions: {composite: true, strict: true},
              include: ['src/**/*.ts'],
            },
            undefined,
            2,
          )}\n`,
        );
      }),
    {concurrency: 16, discard: true},
  );

  const integratedRoot = path.join(repository, 'apps', 'integrated');
  const isolatedRoot = path.join(repository, 'apps', 'isolated');
  yield* fs.makeDirectory(integratedRoot, {recursive: true});
  yield* fs.makeDirectory(isolatedRoot, {recursive: true});
  yield* fs.writeFileString(
    path.join(integratedRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@threadnote/integrated-application',
        private: true,
        version: '1.0.0',
        workspaces: ['modules/*'],
      },
      undefined,
      2,
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(isolatedRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@threadnote/isolated-application',
        private: true,
        version: '1.0.0',
        workspaces: ['packages/*'],
      },
      undefined,
      2,
    )}\n`,
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

  const baseDeclarations = Math.floor(profile.declarationSymbols / profile.sourceFiles);
  const declarationRemainder = profile.declarationSymbols % profile.sourceFiles;
  yield* Effect.forEach(
    Array.from({length: profile.sourceFiles}, (_, fileIndex) => fileIndex),
    fileIndex => {
      const workspaceIndex = fileIndex % workspaces.length;
      const workspaceFileIndex = Math.floor(fileIndex / workspaces.length);
      const declarationCount = baseDeclarations + (fileIndex < declarationRemainder ? 1 : 0);
      const firstSymbol = fileIndex * baseDeclarations + Math.min(fileIndex, declarationRemainder);
      const declarations = Array.from({length: declarationCount}, (_, offset) => {
        const symbolIndex = firstSymbol + offset;
        const name = productionSymbolName(symbolIndex, workspaceIndex);
        const calls = Array.from({length: Math.min(3, offset)}, (_, callOffset) =>
          productionSymbolName(symbolIndex - callOffset - 1, workspaceIndex),
        );
        const body = calls.length === 0 ? `${symbolIndex}` : calls.map(call => `${call}()`).join(' + ');
        return '/** Account workflow feature operation. */\n' + `export function ${name}(): number { return ${body}; }`;
      });
      return fs.writeFileString(
        path.join(
          repository,
          workspaces[workspaceIndex]!,
          'src',
          `module-${String(workspaceFileIndex).padStart(5, '0')}.ts`,
        ),
        `${declarations.join('\n')}\n`,
      );
    },
    {concurrency: 16, discard: true},
  );

  yield* git(repository, ['init', '-q'], 120_000);
  yield* git(repository, ['add', '.'], 15 * 60_000);
  yield* git(
    repository,
    [
      '-c',
      'user.name=Threadnote Evaluation',
      '-c',
      'user.email=evaluation@threadnote.local',
      'commit',
      '-qm',
      `production-scale ${profile.targetGraphSymbols} symbol fixture`,
    ],
    15 * 60_000,
  );
  const incrementalSourcePath = path.join(workspaces[0]!, 'src', `module-${String(0).padStart(5, '0')}.ts`);
  return {
    home,
    incrementalSourcePath,
    profile,
    queryText: productionSymbolName(profile.declarationSymbols - 1, (profile.sourceFiles - 1) % workspaces.length),
    repository,
    root,
  } satisfies PreparedCodeGraphFixture;
});

export function generatedSymbolName(index: number): string {
  return `scaleSymbol${String(index).padStart(6, '0')}`;
}

export function productionSymbolName(index: number, workspaceIndex: number): string {
  return (
    `workspace${String(workspaceIndex).padStart(2, '0')}AccountWorkflow` +
    `FeatureOperation${String(index).padStart(7, '0')}`
  );
}

export function productionWorkspaceRoots(count: number): readonly string[] {
  const candidates = [
    ...Array.from({length: 6}, (_, index) => `apps/application-${String(index).padStart(2, '0')}`),
    ...Array.from({length: 6}, (_, index) => `libs/library-${String(index).padStart(2, '0')}`),
    ...Array.from({length: 4}, (_, index) => `services/service-${String(index).padStart(2, '0')}`),
    ...Array.from({length: 2}, (_, index) => `tools/tool-${String(index).padStart(2, '0')}`),
    ...Array.from({length: 3}, (_, index) => `apps/integrated/modules/module-${String(index).padStart(2, '0')}`),
    ...Array.from({length: 3}, (_, index) => `apps/isolated/packages/package-${String(index).padStart(2, '0')}`),
  ];
  if (!Number.isSafeInteger(count) || count < 1 || count > candidates.length) {
    throw new Error(`Production code graph workspace count must be between 1 and ${candidates.length}.`);
  }
  return candidates.slice(0, count);
}

function validateProductionProfile(profile: ProductionCodeGraphFixtureProfile): ProductionCodeGraphFixtureProfile {
  for (const [name, value] of Object.entries(profile)) {
    if (name === 'id') continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Production code graph profile ${name} must be a positive safe integer.`);
    }
  }
  if (profile.id !== 'production-large' || profile.version !== 1) {
    throw new Error('Unsupported production code graph fixture profile.');
  }
  if (profile.declarationSymbols < profile.sourceFiles) {
    throw new Error('Production code graph fixture requires at least one declaration per source file.');
  }
  productionWorkspaceRoots(profile.workspaceCount);
  return profile;
}

function productionPackageName(index: number): string {
  return `@threadnote/production-workspace-${String(index).padStart(2, '0')}`;
}

export const git = Effect.fn('codeGraphFixture.git')((cwd: string, args: readonly string[], timeoutMs = 30_000) =>
  runCommandEffect('git', ['-C', cwd, ...args], {
    maxOutputBytes: 16 * 1_048_576,
    timeoutMs,
  }),
);
