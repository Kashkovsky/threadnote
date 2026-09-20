import {Console, Effect} from 'effect';
import {Command} from 'effect/unstable/cli';
import {applicationError} from './errors.js';
import {argument, boolean, defaultChoice, repeatedString} from './cli_flags.js';
import {
  mutateManagerManifestProject,
  previewManagerManifestProjectGraphScope,
  readManagerManifestProject,
  readManagerWorksetCatalog,
  validateManagerProjectGraph,
} from '../manager/worksets.js';
import type {RuntimeConfig} from '../types.js';

interface JsonOption {
  readonly json: boolean;
}

export function runCodeGraphScopeSet(
  config: RuntimeConfig,
  options: JsonOption & {
    readonly closure: 'dependencies';
    readonly include: readonly string[];
    readonly project: string;
    readonly roots: readonly string[];
  },
) {
  return Effect.gen(function* () {
    const graph = yield* Effect.try({
      try: () =>
        validateManagerProjectGraph({closure: options.closure, include: options.include, roots: options.roots}),
      catch: cause => applicationError('set graph scope', cause),
    });
    const [catalog, project] = yield* Effect.all([
      readManagerWorksetCatalog(config),
      readManagerManifestProject(config, options.project),
    ]);
    const result = yield* mutateManagerManifestProject(config, {
      expectedRevision: catalog.revision,
      graph,
      name: project.name,
      operation: 'update',
      path: project.path,
      project: project.name,
      seed: project.seed,
      uri: project.uri,
    });
    yield* renderMutation(result.changed, 'set', project.name, options.json, result.warnings);
  });
}

export function runCodeGraphScopeClear(
  config: RuntimeConfig,
  options: JsonOption & {readonly confirm: boolean; readonly project: string},
) {
  return Effect.gen(function* () {
    if (!options.confirm)
      return yield* applicationError('clear graph scope', new Error('Refusing to clear without --confirm.'));
    const [catalog, project] = yield* Effect.all([
      readManagerWorksetCatalog(config),
      readManagerManifestProject(config, options.project),
    ]);
    const result = yield* mutateManagerManifestProject(config, {
      clearGraph: true,
      expectedRevision: catalog.revision,
      name: project.name,
      operation: 'update',
      path: project.path,
      project: project.name,
      seed: project.seed,
      uri: project.uri,
    });
    yield* renderMutation(result.changed, 'cleared', project.name, options.json, result.warnings);
  });
}

export function runCodeGraphScopePreview(config: RuntimeConfig, options: JsonOption & {readonly project: string}) {
  return Effect.gen(function* () {
    const preview = yield* previewManagerManifestProjectGraphScope(config, options.project);
    if (options.json) {
      yield* Console.log(JSON.stringify(preview));
      return;
    }
    yield* Console.log(
      [
        `Graph scope preview: ${preview.project.name}`,
        `Source: ${preview.repository.displayName} @ ${preview.repository.commit.slice(0, 12)}${preview.repository.dirty ? ' + worktree changes' : ''}`,
        `Roots: ${preview.scope.roots.length === 0 ? 'full repository' : preview.scope.roots.join(', ')}`,
        `Root components: ${preview.scope.rootComponents.length === 0 ? 'all discovered components' : preview.scope.rootComponents.join(', ')}`,
        `Dependency components: ${preview.scope.dependencyComponents.length || 'none'}`,
        `Included: ${preview.inventory.included.files} file(s) · ${preview.inventory.included.bytes} bytes`,
        `Excluded by scope: ${preview.inventory.excluded.files} file(s) · ${preview.inventory.excluded.bytes} bytes`,
        `Completeness: ${preview.scope.completeness}`,
        preview.scope.diagnostics.length === 0 ? undefined : `Diagnostics: ${preview.scope.diagnostics.join(' ')}`,
        'Preview only: this command is read-only and does not index or mutate graph state.',
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    );
  });
}

export function makeCodeGraphScopeCommand(
  withRuntime: <E, R>(body: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
  json: ReturnType<typeof boolean>,
) {
  const set = Command.make(
    'set',
    {
      closure: defaultChoice('closure', ['dependencies'], 'Dependency closure policy', 'dependencies'),
      include: repeatedString('include', 'Additional repository-relative path to include; repeat for multiple'),
      json,
      project: argument('project', 'Manifest project name'),
      roots: repeatedString('root', 'Repository-relative component root; repeat for multiple'),
    },
    options => withRuntime(config => runCodeGraphScopeSet(config, options)),
  ).pipe(Command.withDescription('Configure a project graph scope; this does not index the project'));
  const clear = Command.make(
    'clear',
    {
      confirm: boolean(
        'confirm',
        'Required: remove this project graph scope and return to full-repository configuration',
      ),
      json,
      project: argument('project', 'Manifest project name'),
    },
    options => withRuntime(config => runCodeGraphScopeClear(config, options)),
  ).pipe(Command.withDescription('Remove a project graph scope (requires --confirm)'));
  const preview = Command.make('preview', {json, project: argument('project', 'Manifest project name')}, options =>
    withRuntime(config => runCodeGraphScopePreview(config, options)),
  ).pipe(Command.withDescription('Resolve a project graph scope without indexing, storing, or routing queries'));
  return Command.make('scope').pipe(
    Command.withDescription('Configure and preview optional per-project graph scope definitions'),
    Command.withSubcommands([set, preview, clear]),
  );
}

function renderMutation(
  changed: boolean,
  operation: 'set' | 'cleared',
  project: string,
  json: boolean,
  warnings: readonly string[],
) {
  if (json) return Console.log(JSON.stringify({changed, operation, project, version: 1, warnings}));
  return Effect.gen(function* () {
    yield* Console.log(
      `${operation === 'set' ? 'Updated' : 'Cleared'} graph scope for ${project}${changed ? '' : ' (no changes)'}.`,
    );
    for (const warning of warnings) yield* Console.log(`WARN ${warning}`);
  });
}
