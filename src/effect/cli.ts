import {Config, Console, Effect, Option, Schema} from 'effect';
import {Argument, CliError, Command, Flag} from 'effect/unstable/cli';
import {OPENVIKING_MCP_NAME} from '../constants.js';
import {runHooksInstall, runPreCompactHook, runSessionStartHook} from '../hooks.js';
import {runDoctor, runInstall, runRepair, runStart, runStop, runUninstall} from '../lifecycle.js';
import {
  ensureLocalAiStarted,
  readLocalAiSettings,
  runLocalAiDisable,
  runLocalAiEnable,
  runLocalAiInstall,
  runLocalAiModelSwitch,
  runLocalAiStart,
  runLocalAiStatus,
  runLocalAiStop,
  runLocalAiUninstall,
} from './local-ai.js';
import {
  runArchive,
  runCompact,
  runEnrichMemories,
  runExportPack,
  runForget,
  runHandoff,
  runImportPack,
  runList,
  runMigrateLifecycle,
  runMigrateMemories,
  runMigrateProjectNames,
  runRead,
  runRecall,
  runRemember,
} from '../memory.js';
import {runMcpInstall} from '../mcp.js';
import {getRuntimeConfig} from '../runtime.js';
import {runInitManifest, runSeed, runSeedSkills, runWorksetList, runWorksetShow} from '../seeding.js';
import {
  runShareConflictResolve,
  runShareConflicts,
  runShareConflictShow,
  runShareInit,
  runShareInstallArtifacts,
  runShareList,
  runSharePublish,
  runSharePublishArtifact,
  runSharePublishBundle,
  runShareRemove,
  runShareRename,
  runShareSetUrl,
  runShareStatus,
  runShareSync,
  runShareUnpublish,
} from './share.js';
import type {RuntimeConfig} from '../types.js';
import {maybeNotifyUpdate, maybeRunPostUpdateAfterRepair, runPostUpdate, runUpdate} from '../update.js';
import {errorMessage} from '../utils.js';
import {runVersion} from '../version_command.js';
import {runManage} from '../manager.js';
import {applicationError} from './errors.js';

const describeFlag = <A>(flag: Flag.Flag<A>, description: string): Flag.Flag<A> =>
  flag.pipe(Flag.withDescription(description));

const encodedStringPrefix = '\u{f0000}threadnote:';
const valueFlagKinds = new Map<string, 'other' | 'string'>();

const valueFlag = <A>(name: string, flag: Flag.Flag<A>, kind: 'other' | 'string'): Flag.Flag<A> => {
  valueFlagKinds.set(`--${name}`, kind);
  return flag;
};

const stringFlag = (name: string): Flag.Flag<string> =>
  valueFlag(name, Flag.string(name), 'string').pipe(
    Flag.map(value => (value.startsWith(encodedStringPrefix) ? value.slice(encodedStringPrefix.length) : value)),
  );

const integerFlag = (name: string): Flag.Flag<number> => valueFlag(name, Flag.integer(name), 'other');

const withValueAlias = <A>(flag: Flag.Flag<A>, alias: string, kind: 'other' | 'string'): Flag.Flag<A> => {
  valueFlagKinds.set(`-${alias}`, kind);
  return flag.pipe(Flag.withAlias(alias));
};

const optional = <A>(flag: Flag.Flag<A>): Flag.Flag<A | undefined> =>
  flag.pipe(Flag.optional, Flag.map(Option.getOrUndefined));

const optionalString = (name: string, description: string): Flag.Flag<string | undefined> =>
  optional(describeFlag(stringFlag(name), description));

const requiredString = (name: string, description: string): Flag.Flag<string> =>
  describeFlag(stringFlag(name), description);

const defaultString = (name: string, description: string, value: string): Flag.Flag<string> =>
  describeFlag(stringFlag(name), description).pipe(Flag.withDefault(value));

const boolean = (name: string, description: string): Flag.Flag<boolean> =>
  describeFlag(Flag.boolean(name), description);

const negatedBoolean = (name: string, description: string): Flag.Flag<boolean> =>
  describeFlag(Flag.boolean(`no-${name}`), description).pipe(Flag.map(value => !value));

const optionalChoice = <const Choices extends readonly string[]>(
  name: string,
  choices: Choices,
  description: string,
): Flag.Flag<Choices[number] | undefined> =>
  optional(describeFlag(valueFlag(name, Flag.choice(name, choices), 'other'), description));

const defaultChoice = <const Choices extends readonly string[], const Value extends Choices[number]>(
  name: string,
  choices: Choices,
  description: string,
  value: Value,
): Flag.Flag<Choices[number]> =>
  describeFlag(valueFlag(name, Flag.choice(name, choices), 'other'), description).pipe(Flag.withDefault(value));

const repeatedString = (name: string, description: string): Flag.Flag<ReadonlyArray<string>> =>
  describeFlag(stringFlag(name), description).pipe(Flag.atMost(1000));

const argument = (name: string, description: string): Argument.Argument<string> =>
  Argument.string(name).pipe(Argument.withDescription(description));

const optionalArgument = (name: string, description: string, fallback: string): Argument.Argument<string> =>
  argument(name, description).pipe(Argument.withDefault(fallback));

const root = Command.make('threadnote').pipe(
  Command.withSharedFlags({
    home: optionalString('home', 'Override THREADNOTE_HOME for this invocation'),
    host: optionalString('host', 'Override THREADNOTE_HOST for this invocation'),
    manifest: optionalString('manifest', 'Override THREADNOTE_MANIFEST for this invocation'),
    port: optional(
      describeFlag(integerFlag('port'), 'Override THREADNOTE_PORT for this invocation').pipe(
        Flag.withSchema(Config.Port),
      ),
    ),
  }),
);

const withRuntimeEffect = <E, R>(
  effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>,
  manifestOverride?: string,
) =>
  Effect.flatMap(root, options =>
    getRuntimeConfig(options, manifestOverride).pipe(
      Effect.mapError(cause => applicationError('load runtime configuration', cause)),
      Effect.flatMap(effect),
    ),
  );

const manage = Command.make(
  'manage',
  {
    open: negatedBoolean('open', 'Start the manager without opening a browser'),
    uiPort: optional(
      describeFlag(
        integerFlag('ui-port').pipe(Flag.withSchema(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 65_535})))),
        'Port for the local manager UI; defaults to a random free port',
      ),
    ),
  },
  options => withRuntimeEffect(config => runManage(config, options)),
).pipe(Command.withDescription('Open the local Threadnote web manager'));

const doctor = Command.make(
  'doctor',
  {
    dryRun: boolean('dry-run', 'Show checks without writing anything'),
    strict: boolean('strict', 'Exit non-zero if any check fails'),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        yield* runDoctor(config, options);
        yield* maybeNotifyUpdate(config, {dryRun: options.dryRun});
      }),
    ),
).pipe(Command.withDescription('Check local prerequisites, config files, manifest shape, and server health'));

const install = Command.make(
  'install',
  {
    dryRun: boolean('dry-run', 'Print the actions without making changes'),
    force: boolean('force', 'Reinstall OpenViking at the pinned version even if a working install is already present'),
    packageManager: optionalChoice('package-manager', ['uv', 'pipx', 'pip'], 'uv, pipx, or pip'),
    start: negatedBoolean('start', 'Do not start OpenViking or check server health after installing'),
    withHooks: boolean(
      'with-hooks',
      'Also install agent-side hooks for deterministic handoff snapshots and context preload',
    ),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        yield* runInstall(config, options);
        yield* maybeRunPostUpdateAfterRepair(config, {dryRun: options.dryRun});
        if (options.withHooks) {
          for (const agent of ['claude', 'codex', 'cursor', 'copilot'] as const) {
            yield* Console.log(`\n--- ${agent} hooks ---`);
            yield* runHooksInstall(config, agent, {apply: !options.dryRun, dryRun: options.dryRun});
          }
        }
        yield* maybeNotifyUpdate(config, {dryRun: options.dryRun});
      }),
    ),
).pipe(
  Command.withDescription('Install OpenViking, local config files, command shim, and user-level agent instructions'),
);

const version = Command.make(
  'version',
  {
    allowUntrustedRegistry: boolean(
      'allow-untrusted-registry',
      'Allow a non-default npm registry without package signature verification',
    ),
    registry: optionalString('registry', 'npm registry URL'),
  },
  options => withRuntimeEffect(config => runVersion(config, options)),
).pipe(Command.withDescription('Print the installed Threadnote version, latest npm version, and release notes'));

const update = Command.make(
  'update',
  {
    allowUntrustedRegistry: boolean(
      'allow-untrusted-registry',
      'Allow a non-default npm registry without package signature verification',
    ),
    beta: boolean('beta', 'Update to the latest beta release'),
    check: boolean('check', 'Only check whether a newer version is available'),
    dryRun: boolean('dry-run', 'Print update and repair commands without running them'),
    force: boolean('force', 'Run package-manager update even if this version is already current'),
    postUpdate: negatedBoolean('post-update', 'Skip post-update migration prompts'),
    registry: optionalString('registry', 'npm registry URL'),
    repair: negatedBoolean('repair', 'Skip threadnote repair after updating the package'),
    runtime: defaultChoice('runtime', ['auto', 'npm', 'bun', 'deno'], 'auto, npm, bun, or deno', 'auto'),
    stable: boolean('stable', 'Switch to the latest stable release'),
    yes: boolean('yes', 'Accept applicable post-update actions without prompting'),
  },
  options => withRuntimeEffect(config => runUpdate(config, options)),
).pipe(Command.withDescription('Update the published Threadnote package, then repair local shims and MCP config'));

const postUpdate = Command.make(
  'post-update',
  {
    dryRun: boolean('dry-run', 'Print post-update actions without running them'),
    fromVersion: requiredString('from-version', 'Version before update'),
    toVersion: requiredString('to-version', 'Version after update'),
    yes: boolean('yes', 'Accept applicable post-update actions without prompting'),
  },
  options => withRuntimeEffect(config => runPostUpdate(config, options)),
).pipe(Command.withDescription('Run packaged post-update action prompts'), Command.withHidden);

const repair = Command.make(
  'repair',
  {
    dryRun: boolean('dry-run', 'Print the repair actions without making changes'),
    mcp: defaultString(
      'mcp',
      'MCP clients: available, all, none, codex, claude, cursor, copilot, or comma-separated list',
      'available',
    ),
    packageManager: optionalChoice('package-manager', ['uv', 'pipx', 'pip'], 'uv, pipx, or pip'),
    postUpdate: negatedBoolean('post-update', 'Skip post-update migration prompts after repair'),
    start: negatedBoolean('start', 'Do not start OpenViking if health is failing'),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        yield* runRepair(config, options);
        if (options.start !== false && (yield* readLocalAiSettings(config))?.enabled === true) {
          if (options.dryRun) {
            yield* runLocalAiStart(config, {dryRun: true});
          } else {
            yield* ensureLocalAiStarted(config).pipe(
              Effect.catch(error => Console.warn(`WARN could not repair local AI health: ${errorMessage(error)}`)),
            );
          }
        }
        yield* maybeNotifyUpdate(config, {dryRun: options.dryRun});
      }),
    ),
).pipe(
  Command.withDescription('Repair local OpenViking install, config, server health, shim, manifest, and MCP config'),
);

const start = Command.make(
  'start',
  {
    dryRun: boolean('dry-run', 'Print the start command without running it'),
    foreground: boolean('foreground', 'Run in the foreground instead of detaching'),
    launchd: boolean('launchd', 'Install and start a macOS LaunchAgent'),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        const localAiConfigured = (yield* readLocalAiSettings(config))?.enabled === true;
        if (options.foreground && localAiConfigured) {
          yield* runLocalAiStart(config, options);
        }
        yield* runStart(config, options);
        if (!options.foreground && localAiConfigured) {
          yield* runLocalAiStart(config, options);
        }
        yield* maybeNotifyUpdate(config, {dryRun: options.dryRun});
      }),
    ),
).pipe(Command.withDescription('Start the local OpenViking server'));

const stop = Command.make(
  'stop',
  {dryRun: boolean('dry-run', 'Print the stop actions without running them')},
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        if (yield* readLocalAiSettings(config)) {
          yield* runLocalAiStop(config, options);
        }
        yield* runStop(config, options);
      }),
    ),
).pipe(Command.withDescription('Stop the local OpenViking server or LaunchAgent'));

const uninstall = Command.make(
  'uninstall',
  {
    dryRun: boolean('dry-run', 'Print uninstall actions without making changes'),
    eraseMemories: boolean('erase-memories', 'Delete THREADNOTE_HOME, including all OpenViking memories'),
    mcp: defaultString(
      'mcp',
      'MCP clients to remove: available, all, none, codex, claude, cursor, copilot, or comma-separated list',
      'available',
    ),
    preserveMemories: boolean('preserve-memories', 'Preserve THREADNOTE_HOME and OpenViking memories (default)'),
  },
  options =>
    withRuntimeEffect(config =>
      Effect.gen(function* () {
        if (yield* readLocalAiSettings(config)) {
          yield* runLocalAiStop(config, options);
        }
        yield* runUninstall(config, options);
      }),
    ),
).pipe(Command.withDescription('Remove Threadnote setup and optionally erase local memories'));

const localAiInstall = Command.make(
  'install',
  {
    dryRun: boolean('dry-run', 'Print local AI installation actions without making changes'),
    force: boolean('force', 'Re-download and re-verify the managed model'),
    model: optionalString('model', 'Verified model to install: gemma-4-E4B-it-Q4_0'),
    modelPath: optionalString('model-path', 'Use an existing verified GGUF file for the selected model'),
    start: negatedBoolean('start', 'Install and configure without starting the local model service'),
  },
  options => withRuntimeEffect(config => runLocalAiInstall(config, options)),
).pipe(Command.withDescription('Install and enable a local recall model (Gemma by default)'));

const localAiEnable = Command.make(
  'enable',
  {dryRun: boolean('dry-run', 'Print the local AI enable action without changing configuration')},
  options => withRuntimeEffect(config => runLocalAiEnable(config, options)),
).pipe(Command.withDescription('Enable an installed local recall model'));

const localAiDisable = Command.make(
  'disable',
  {dryRun: boolean('dry-run', 'Print the local AI disable action without changing configuration')},
  options => withRuntimeEffect(config => runLocalAiDisable(config, options)),
).pipe(Command.withDescription('Disable local AI recall without removing its model'));

const localAiStart = Command.make(
  'start',
  {dryRun: boolean('dry-run', 'Print the local AI start action without running it')},
  options => withRuntimeEffect(config => runLocalAiStart(config, options)),
).pipe(Command.withDescription('Start the configured loopback model service'));

const localAiStop = Command.make(
  'stop',
  {dryRun: boolean('dry-run', 'Print the local AI stop action without running it')},
  options => withRuntimeEffect(config => runLocalAiStop(config, options)),
).pipe(Command.withDescription('Stop the configured loopback model service'));

const localAiStatus = Command.make('status', {}, () => withRuntimeEffect(config => runLocalAiStatus(config))).pipe(
  Command.withDescription('Show local model installation and health'),
);

const localAiModelSwitch = Command.make(
  'switch',
  {
    dryRun: boolean('dry-run', 'Select a model and print the switch actions without changing configuration'),
    model: optionalString('model', 'Switch directly to an installed model instead of prompting'),
  },
  options => withRuntimeEffect(config => runLocalAiModelSwitch(config, options)),
).pipe(Command.withDescription('Interactively switch between installed local AI models'));

const localAiModel = Command.make('model').pipe(
  Command.withDescription('Manage installed local AI models'),
  Command.withSubcommands([localAiModelSwitch]),
);

const localAiUninstall = Command.make(
  'uninstall',
  {
    dryRun: boolean('dry-run', 'Print local AI removal actions without making changes'),
    eraseModel: boolean('erase-model', 'Also delete a model inside the Threadnote-managed model directory'),
  },
  options => withRuntimeEffect(config => runLocalAiUninstall(config, options)),
).pipe(Command.withDescription('Remove local AI configuration and optionally its managed model'));

const localAi = Command.make('local-ai').pipe(
  Command.withDescription('Manage opt-in local AI recall'),
  Command.withSubcommands([
    localAiInstall,
    localAiEnable,
    localAiDisable,
    localAiStart,
    localAiStop,
    localAiStatus,
    localAiModel,
    localAiUninstall,
  ]),
);

const seed = Command.make(
  'seed',
  {
    dryRun: boolean('dry-run', 'Print files and ov commands without importing'),
    force: boolean('force', 'Re-upload every candidate even if recorded state matches'),
    graph: boolean('graph', 'Also seed per-project dependency facts with cross-repo edges'),
    only: repeatedString('only', 'Restrict seeding to one or more manifest projects; repeat for multiple'),
  },
  options => withRuntimeEffect(config => runSeed(config, options)),
).pipe(Command.withDescription('Seed curated context from the manifest; never indexes whole repos by default'));

const initManifest = Command.make(
  'init-manifest',
  {
    dryRun: boolean('dry-run', 'Print the manifest without writing it'),
    path: optionalString('path', 'Manifest path; defaults to THREADNOTE_MANIFEST or the user manifest'),
    replace: boolean('replace', 'Replace the manifest instead of merging with existing projects'),
    repo: repeatedString('repo', 'Repo root to include; repeat for multiple repos'),
  },
  options => withRuntimeEffect(config => runInitManifest(config, options)),
).pipe(Command.withDescription('Create or update a per-developer seed manifest from one or more repo roots'));

const seedSkills = Command.make(
  'seed-skills',
  {
    dryRun: boolean('dry-run', 'Print skill files and ov commands without importing'),
    native: boolean('native', 'Use native OpenViking skill ingestion; requires a working VLM config'),
  },
  options => withRuntimeEffect(config => runSeedSkills(config, options)),
).pipe(Command.withDescription('Seed Codex/Claude skills and Claude command markdown files as a searchable catalog'));

const mcpInstall = Command.make(
  'mcp-install',
  {
    agent: Argument.choice('agent', ['codex', 'claude', 'cursor', 'copilot']).pipe(
      Argument.withDescription('codex, claude, cursor, or copilot'),
    ),
    apply: boolean('apply', 'Actually modify the selected agent config'),
    bearerTokenEnvVar: optionalString('bearer-token-env-var', 'Environment variable containing the local API key'),
    name: defaultString('name', 'MCP server name', OPENVIKING_MCP_NAME),
    nativeHttp: boolean('native-http', 'Install OpenViking native HTTP MCP instead of the local stdio adapter'),
    scope: defaultChoice('scope', ['user', 'local', 'project'], 'Claude MCP config scope', 'user'),
    toolset: optionalChoice('toolset', ['core', 'full'], 'Stdio adapter toolset'),
    url: optionalString('url', 'OpenViking native HTTP MCP URL'),
  },
  ({agent, ...options}) => withRuntimeEffect(config => runMcpInstall(config, agent, options)),
).pipe(Command.withDescription('Install OpenViking MCP config for a supported agent'));

const installHooks = Command.make(
  'install-hooks',
  {
    agent: Argument.choice('agent', ['codex', 'claude', 'cursor', 'copilot']).pipe(
      Argument.withDescription('codex, claude, cursor, or copilot'),
    ),
    apply: boolean('apply', 'Actually modify the selected agent config'),
    dryRun: boolean('dry-run', 'Print the planned change without applying it'),
    remove: boolean('remove', 'Remove threadnote-managed hook entries instead of adding them'),
  },
  ({agent, ...options}) => withRuntimeEffect(config => runHooksInstall(config, agent, options)),
).pipe(Command.withDescription('Install deterministic agent lifecycle hooks'));

const preCompactHook = Command.make(
  'pre-compact-hook',
  {dryRun: boolean('dry-run', 'Print the handoff payload without writing it')},
  options => withRuntimeEffect(config => runPreCompactHook(config, options)),
).pipe(Command.withDescription('Store a handoff snapshot before context compaction'), Command.withHidden);

const sessionStartHook = Command.make(
  'session-start-hook',
  {dryRun: boolean('dry-run', 'Print the planned ov command without running it')},
  options => withRuntimeEffect(config => runSessionStartHook(config, options)),
).pipe(Command.withDescription('Print current repo handoff context at session start'), Command.withHidden);

const remember = Command.make(
  'remember',
  {
    dryRun: boolean('dry-run', 'Print memory and ov command without storing'),
    kind: defaultChoice(
      'kind',
      ['durable', 'handoff', 'incident', 'preference', 'smoke'],
      'Memory lifecycle kind',
      'durable',
    ),
    project: optionalString('project', 'Project/repo/topic namespace for lifecycle-aware storage'),
    replace: optionalString('replace', 'Supersede an existing viking:// memory after storing the new memory'),
    sourceAgentClient: defaultString('source-agent-client', 'Originating agent client name', 'codex'),
    status: defaultChoice('status', ['active', 'archived', 'superseded'], 'Memory lifecycle status', 'active'),
    stdin: boolean('stdin', 'Read memory text from stdin'),
    text: optionalString('text', 'Memory text to store'),
    topic: optionalString('topic', 'Stable topic name for an active project/topic memory'),
  },
  options => withRuntimeEffect(config => runRemember(config, options)),
).pipe(Command.withDescription('Store a durable engineering memory in OpenViking'));

const migrateMemories = Command.make(
  'migrate-memories',
  {
    allAccounts: boolean('all-accounts', 'Scan all local OpenViking accounts under THREADNOTE_HOME'),
    dryRun: boolean('dry-run', 'Print migration actions without writing memories'),
    limit: optionalString('limit', 'Maximum number of memories to migrate'),
    sourceAccount: repeatedString('source-account', 'Source OpenViking account; repeat for multiple accounts'),
  },
  options => withRuntimeEffect(config => runMigrateMemories(config, options)),
).pipe(Command.withDescription('Migrate legacy session-only memories into durable memory files'));

const migrateLifecycle = Command.make(
  'migrate-lifecycle',
  {
    apply: boolean('apply', 'Perform the migration; without this, prints a dry run'),
    dryRun: boolean('dry-run', 'Print migration actions without changing memories'),
    limit: optionalString('limit', 'Maximum number of legacy handoffs to migrate'),
  },
  options => withRuntimeEffect(config => runMigrateLifecycle(config, options)),
).pipe(Command.withDescription('Move clear legacy handoff memories into lifecycle-aware archive paths'));

const migrateProjectNamesFlags = {
  apply: boolean('apply', 'Perform the migration; without this, prints a dry run'),
  dryRun: boolean('dry-run', 'Print migration actions without changing memories'),
  limit: optionalString('limit', 'Maximum number of memories to migrate'),
};

const migrateProjectNames = Command.make('migrate-projects', migrateProjectNamesFlags, options =>
  withRuntimeEffect(config => runMigrateProjectNames(config, options)),
).pipe(Command.withDescription('Move memories from clone-folder project names to the git remote repo name'));

const migrateProjectNamesCompatibility = Command.make('migrate-project-names', migrateProjectNamesFlags, options =>
  withRuntimeEffect(config => runMigrateProjectNames(config, options)),
).pipe(Command.withDescription('Compatibility name for migrate-projects'), Command.withHidden);

const enrichMemories = Command.make(
  'enrich-memories',
  {
    apply: boolean('apply', 'Generate and store local-model search keywords; without this, prints a dry run'),
    dryRun: boolean('dry-run', 'Print eligible memories without changing them'),
    force: boolean('force', 'Regenerate keywords for memories that are already enriched'),
    installLocalAi: boolean('install-local-ai', 'Install the pinned local model first when it is not installed'),
    limit: optionalString('limit', 'Maximum number of memories to enrich'),
  },
  options => withRuntimeEffect(config => runEnrichMemories(config, options)),
).pipe(Command.withDescription('Enrich personal and shared memories with local-model retrieval keywords'));

const recall = Command.make(
  'recall',
  {
    callerCwd: optionalString('caller-cwd', 'Absolute caller workspace path for current repo/branch resolution'),
    dryRun: boolean('dry-run', 'Print ov command without searching'),
    includeArchived: boolean('include-archived', 'Include archived memories in recall results'),
    inferScope: negatedBoolean('infer-scope', 'Disable query-based scope inference'),
    nodeLimit: withValueAlias(optionalString('node-limit', 'Maximum number of search results'), 'n', 'string'),
    project: optionalString('project', 'Add a scoped project memory pass alongside global search'),
    query: requiredString('query', 'Search query'),
    threshold: optionalString('threshold', 'Minimum relevance score 0-1'),
    uri: optionalString('uri', 'Restrict search to a viking:// URI'),
    workset: optionalString('workset', 'Recall across a named seed-manifest workset'),
  },
  options => withRuntimeEffect(config => runRecall(config, options)),
).pipe(Command.withDescription('Search shared OpenViking context'));

const worksetList = Command.make('list', {}, () => withRuntimeEffect(config => runWorksetList(config))).pipe(
  Command.withDescription('List worksets defined in the seed manifest'),
);

const worksetShow = Command.make('show', {name: argument('name', 'Workset name')}, ({name}) =>
  withRuntimeEffect(config => runWorksetShow(config, name)),
).pipe(Command.withDescription('Show the member projects of a workset'));

const workset = Command.make('workset').pipe(
  Command.withDescription('Inspect named sets of related repos'),
  Command.withSubcommands([worksetList, worksetShow]),
);

const compact = Command.make(
  'compact',
  {
    apply: boolean('apply', 'Apply the compact plan; without this, prints a dry run'),
    dryRun: boolean('dry-run', 'Print the compact plan without changing anything'),
    kind: optionalChoice('kind', ['durable', 'handoff', 'incident'], 'Optional memory kind filter'),
    project: requiredString('project', 'Project/repo namespace to inspect'),
    topic: optionalString('topic', 'Stable topic name to inspect'),
  },
  options => withRuntimeEffect(config => runCompact(config, options)),
).pipe(Command.withDescription('Plan or apply scoped memory hygiene for active personal memories'));

const read = Command.make(
  'read',
  {dryRun: boolean('dry-run', 'Print ov command without reading'), uri: argument('uri', 'viking:// URI to read')},
  ({uri, ...options}) => withRuntimeEffect(config => runRead(config, uri, options)),
).pipe(Command.withDescription('Read a viking:// URI returned by recall or list'));

const list = Command.make(
  'list',
  {
    all: boolean('all', 'Show hidden files such as .abstract.md and .overview.md').pipe(Flag.withAlias('a')),
    dryRun: boolean('dry-run', 'Print ov command without listing'),
    nodeLimit: withValueAlias(optionalString('node-limit', 'Maximum number of nodes to list'), 'n', 'string'),
    recursive: boolean('recursive', 'List subdirectories recursively').pipe(Flag.withAlias('r')),
    simple: boolean('simple', 'Print only paths').pipe(Flag.withAlias('s')),
    uri: optionalArgument('uri', 'viking:// directory URI', 'viking://'),
  },
  ({uri, ...options}) => withRuntimeEffect(config => runList(config, uri, options)),
).pipe(Command.withDescription('List a viking:// directory'), Command.withAlias('ls'));

const handoff = Command.make(
  'handoff',
  {
    blockers: optionalString('blockers', 'Known blockers'),
    ci: optionalString('ci', 'Captured CI status snapshot'),
    dryRun: boolean('dry-run', 'Print handoff without storing'),
    issue: optionalString('issue', 'Related issue reference'),
    nextStep: optionalString('next-step', 'Suggested next step'),
    pr: optionalString('pr', 'Related pull request reference'),
    project: optionalString('project', 'Project/repo namespace; defaults to current repo'),
    reference: repeatedString('reference', 'Prior viking:// context URI; repeat for multiple'),
    replace: optionalString('replace', 'Supersede an existing memory after storing the handoff'),
    sourceAgentClient: defaultString('source-agent-client', 'Originating agent client name', 'codex'),
    task: optionalString('task', 'Current task summary'),
    tests: optionalString('tests', 'Tests or checks run'),
    timestamped: boolean('timestamped', 'Store a historical timestamped handoff'),
    topic: optionalString('topic', 'Stable topic name'),
  },
  options => withRuntimeEffect(config => runHandoff(config, {...options, references: options.reference})),
).pipe(Command.withDescription('Capture current repo state as a durable cross-agent handoff memory'));

const archive = Command.make(
  'archive',
  {
    dryRun: boolean('dry-run', 'Print archive content and commands without changing anything'),
    kind: optionalChoice('kind', ['durable', 'handoff', 'incident', 'preference', 'smoke'], 'Memory kind'),
    project: optionalString('project', 'Override inferred project/repo namespace'),
    topic: optionalString('topic', 'Override inferred topic'),
    uri: argument('uri', 'viking:// memory URI to archive'),
  },
  ({uri, ...options}) => withRuntimeEffect(config => runArchive(config, uri, options)),
).pipe(Command.withDescription('Move a memory into the archived lifecycle tree'));

const forget = Command.make(
  'forget',
  {dryRun: boolean('dry-run', 'Print ov command without deleting'), uri: argument('uri', 'viking:// URI to remove')},
  ({uri, ...options}) => withRuntimeEffect(config => runForget(config, uri, options)),
).pipe(Command.withDescription('Remove a viking:// URI from local OpenViking context'));

const shareInit = Command.make(
  'init',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    push: negatedBoolean('push', 'Do not push the generated housekeeping commit'),
    remoteUrl: argument('remote-url', 'git remote URL of the shared memories repo'),
    setDefault: boolean('set-default', 'Mark this team as the default'),
    team: optionalString('team', 'Team name; defaults to default'),
  },
  ({remoteUrl, ...options}) => withRuntimeEffect(config => runShareInit(config, remoteUrl, options)),
).pipe(Command.withDescription('Configure a shared memories repo for a team'));

const shareStatus = Command.make(
  'status',
  {dryRun: boolean('dry-run', 'Print git commands'), team: optionalString('team', 'Team name')},
  options => withRuntimeEffect(config => runShareStatus(config, options)),
).pipe(Command.withDescription('Show git status and ahead/behind counts for a shared team'));

const shareSync = Command.make(
  'sync',
  {
    autoCommit: negatedBoolean('auto-commit', 'Refuse to sync with uncommitted local changes'),
    dryRun: boolean('dry-run', 'Print actions without running them'),
    message: optionalString('message', 'Commit message for local edits'),
    push: negatedBoolean('push', 'Skip the push step'),
    team: optionalString('team', 'Team name; omit to sync all teams'),
  },
  options => withRuntimeEffect(config => runShareSync(config, options)),
).pipe(Command.withDescription('Pull, reindex, and push shared memories repos'));

const shareConflicts = Command.make(
  'conflicts',
  {team: optionalString('team', 'Team name; defaults to all teams')},
  options => withRuntimeEffect(config => runShareConflicts(config, options)),
).pipe(Command.withDescription('List pending shared memory conflicts'));

const conflictShow = Command.make(
  'show',
  {
    conflictId: argument('conflict-id', 'Conflict id, relative path, or shared viking:// URI'),
    team: optionalString('team', 'Team name for a relative path'),
  },
  ({conflictId, ...options}) => withRuntimeEffect(config => runShareConflictShow(config, conflictId, options)),
).pipe(Command.withDescription('Show local/shared content for one conflict'));

const conflictResolve = Command.make(
  'resolve',
  {
    conflictId: argument('conflict-id', 'Conflict id, relative path, or shared viking:// URI'),
    dryRun: boolean('dry-run', 'Print actions without writing'),
    fromFile: optionalString('from-file', 'Merged memory markdown to write to both stores'),
    message: optionalString('message', 'Commit message'),
    push: negatedBoolean('push', 'Skip pushing the resolution commit'),
    take: optionalChoice('take', ['shared', 'local'], 'Resolution side'),
    team: optionalString('team', 'Team name for a relative path'),
  },
  ({conflictId, ...options}) => withRuntimeEffect(config => runShareConflictResolve(config, conflictId, options)),
).pipe(Command.withDescription('Resolve one pending shared memory conflict'));

const shareConflict = Command.make('conflict').pipe(
  Command.withDescription('Inspect or resolve one pending shared memory conflict'),
  Command.withSubcommands([conflictShow, conflictResolve]),
);

const publishFlags = {
  dryRun: boolean('dry-run', 'Print actions without running them'),
  message: optionalString('message', 'Commit message override'),
  preview: boolean('preview', 'Print exact shared bytes without writing or committing'),
  push: negatedBoolean('push', 'Skip the push step'),
  redact: boolean('redact', 'Redact soft leaks; credentials still block'),
  team: optionalString('team', 'Team name'),
} as const;

const sharePublish = Command.make(
  'publish',
  {...publishFlags, uri: argument('viking-uri', 'Personal viking:// memory URI')},
  ({uri, ...options}) => withRuntimeEffect(config => runSharePublish(config, uri, options)),
).pipe(Command.withDescription('Move a personal memory into the shared team namespace, commit and push'));

const artifactFlags = {
  ...publishFlags,
  agent: optionalChoice('agent', ['codex', 'claude'], 'Agent owner'),
  allowBinary: boolean('allow-binary', 'Include binary files that the scrubber cannot scan'),
  force: boolean('force', 'Replace existing shared files with different content'),
  kind: optionalChoice('kind', ['skill', 'command', 'pack'], 'Shared artifact kind'),
  name: optionalString('name', 'Shared artifact name'),
} as const;

const sharePublishArtifact = Command.make(
  'publish-artifact',
  {...artifactFlags, path: argument('path', 'Path to SKILL.md or a Claude command file')},
  ({path, ...options}) => withRuntimeEffect(config => runSharePublishArtifact(config, path, options)),
).pipe(Command.withDescription('Publish a local agent skill or command into the shared team repo'));

const sharePublishBundle = Command.make(
  'publish-bundle',
  {...artifactFlags, manifest: argument('manifest', 'Path to a threadnote-bundle.json manifest')},
  ({manifest, ...options}) => withRuntimeEffect(config => runSharePublishBundle(config, manifest, options)),
).pipe(Command.withDescription('Publish a multi-skill constellation declared by a bundle manifest'));

const shareInstallArtifacts = Command.make(
  'install-artifacts',
  {
    agent: optionalChoice('agent', ['codex', 'claude'], 'Agent filter'),
    apply: boolean('apply', 'Actually write local artifact files'),
    dryRun: boolean('dry-run', 'Preview without writing files'),
    force: boolean('force', 'Replace existing installed artifacts'),
    kind: optionalChoice('kind', ['skill', 'command', 'pack'], 'Artifact kind filter'),
    name: optionalString('name', 'Shared artifact name filter'),
    sync: negatedBoolean('sync', 'Skip pulling shared updates first'),
    team: optionalString('team', 'Team name'),
  },
  options => withRuntimeEffect(config => runShareInstallArtifacts(config, options)),
).pipe(Command.withDescription('Install shared agent skills and commands from a team repo'));

const shareUnpublish = Command.make(
  'unpublish',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    message: optionalString('message', 'Commit message override'),
    push: negatedBoolean('push', 'Skip the push step'),
    team: optionalString('team', 'Team name'),
    uri: argument('viking-uri', 'Shared viking:// memory URI'),
  },
  ({uri, ...options}) => withRuntimeEffect(config => runShareUnpublish(config, uri, options)),
).pipe(Command.withDescription('Pull a shared memory back into the personal namespace'));

const shareList = Command.make('list', {dryRun: boolean('dry-run', 'Print without side effects')}, options =>
  withRuntimeEffect(config => runShareList(config, options)),
).pipe(Command.withDescription('List configured shared teams'));

const shareRename = Command.make(
  'rename',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    team: requiredString('team', 'Existing team name'),
    to: requiredString('to', 'New team name'),
  },
  options => withRuntimeEffect(config => runShareRename(config, options)),
).pipe(Command.withDescription('Rename a configured shared team'));

const shareSetUrl = Command.make(
  'set-url',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    remoteUrl: argument('remote-url', 'New git remote URL'),
    team: optionalString('team', 'Team name'),
  },
  ({remoteUrl, ...options}) => withRuntimeEffect(config => runShareSetUrl(config, remoteUrl, options)),
).pipe(Command.withDescription('Change a shared team git remote URL'));

const shareRemove = Command.make(
  'remove',
  {
    dryRun: boolean('dry-run', 'Print actions without running them'),
    keepFiles: boolean('keep-files', 'Keep worktree and gitdir files'),
    preserveLocal: boolean('preserve-local', 'Copy durable memories into the personal tree first'),
    team: optionalString('team', 'Team name'),
  },
  options => withRuntimeEffect(config => runShareRemove(config, options)),
).pipe(Command.withDescription('Forget a configured team and optionally delete its files'));

const share = Command.make('share').pipe(
  Command.withDescription('Share durable memories with teammates through a git-backed repository'),
  Command.withSubcommands([
    shareInit,
    shareStatus,
    shareSync,
    shareConflicts,
    shareConflict,
    sharePublish,
    sharePublishArtifact,
    sharePublishBundle,
    shareInstallArtifacts,
    shareUnpublish,
    shareList,
    shareRename,
    shareSetUrl,
    shareRemove,
  ]),
);

const exportPack = Command.make(
  'export-pack',
  {
    dryRun: boolean('dry-run', 'Print ov command without exporting'),
    path: optionalString('path', 'Output .ovpack path'),
    uri: optionalString('uri', 'Source viking:// URI; defaults to the current user memories'),
  },
  options => withRuntimeEffect(config => runExportPack(config, options)),
).pipe(Command.withDescription('Export local OpenViking context to an .ovpack'));

const importPack = Command.make(
  'import-pack',
  {
    dryRun: boolean('dry-run', 'Print ov command without importing'),
    path: requiredString('path', 'Input .ovpack path'),
    targetUri: optionalString('target-uri', 'Target parent viking:// URI; defaults to the current user'),
  },
  options => withRuntimeEffect(config => runImportPack(config, options)),
).pipe(Command.withDescription('Import an .ovpack into local OpenViking context'));

export const threadnoteCommand = root.pipe(
  Command.withDescription('Threadnote shared context workflow for development agents'),
  Command.withSubcommands([
    manage,
    doctor,
    install,
    version,
    update,
    postUpdate,
    repair,
    start,
    stop,
    uninstall,
    localAi,
    seed,
    initManifest,
    seedSkills,
    mcpInstall,
    installHooks,
    preCompactHook,
    sessionStartHook,
    remember,
    migrateMemories,
    migrateLifecycle,
    migrateProjectNames,
    migrateProjectNamesCompatibility,
    enrichMemories,
    recall,
    workset,
    compact,
    read,
    list,
    handoff,
    archive,
    forget,
    share,
    exportPack,
    importPack,
  ]),
);

/**
 * Preserve Commander-compatible string values while Effect 4's beta lexer
 * still tokenizes dash-prefixed values as flags and splits inline values at
 * every equals sign. Remove this shim once the upstream lexer preserves both.
 */
export function normalizeCliArguments(args: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? '';
    const equalsIndex = current.indexOf('=');
    const inlineName = equalsIndex > 0 ? current.slice(0, equalsIndex) : current;
    const kind = valueFlagKinds.get(inlineName);
    if (!kind) {
      normalized.push(current);
      continue;
    }

    if (equalsIndex > 0) {
      const value = current.slice(equalsIndex + 1);
      if (kind === 'string') {
        normalized.push(inlineName, encodeStringArgument(value));
      } else {
        normalized.push(current);
      }
      continue;
    }

    const next = args[index + 1];
    if (next?.startsWith('-') && next !== '-') {
      normalized.push(kind === 'string' ? current : `${current}=${next}`);
      if (kind === 'string') {
        normalized.push(encodeStringArgument(next));
      }
      index += 1;
      continue;
    }
    normalized.push(current);
  }
  return normalized;
}

function encodeStringArgument(value: string): string {
  return value.startsWith('-') ? `${encodedStringPrefix}${value}` : value;
}

export {CliError};
