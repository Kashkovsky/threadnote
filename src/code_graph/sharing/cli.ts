import {Command} from 'effect/unstable/cli';
import type {Effect} from 'effect';
import {boolean, optionalString, requiredChoice} from '../../effect/cli_flags.js';
import {codeGraphCliBounds} from '../../effect/code_graph_cli_flags.js';
import type {RuntimeConfig} from '../../types.js';
import {
  runGraphContributeSetCommand,
  runGraphContributeStatusCommand,
  runGraphPublisherBootstrapCommand,
  runGraphPublisherServeCommand,
  runGraphPublisherStatusCommand,
  runGraphShareInitCommand,
  runGraphShareJoinCommand,
  runGraphShareLeaveCommand,
  runGraphShareStatusCommand,
  runGraphWorkerCommand,
} from './commands.js';

export function makeGraphSharingCommands(
  withRuntimeEffect: <E, R>(effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const graphShareInit = Command.make(
    'init',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory for organization-issued profiles'),
      coordinator: optionalString('coordinator', 'HTTPS coordinator URL, or loopback HTTP for local publisher serve'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      organization: optionalString('organization', 'Organization identity recorded in the issued profile'),
      writeConfig: boolean('write-config', 'Write .threadnote/graph-share.json in the repository'),
    },
    options => withRuntimeEffect(config => runGraphShareInitCommand(config, options)),
  ).pipe(Command.withDescription('Issue a digest-pinned organization profile and optional enrollment pointer'));

  const graphShareJoin = Command.make(
    'join',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory that stores the enrolled profile'),
      coordinator: optionalString(
        'coordinator',
        'Coordinator URL used to fetch the enrolled profile and later frontiers without a shared CAS directory',
      ),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      readOnly: boolean(
        'read-only',
        'Trust the enrolled profile without contribution; the next graph index may import a verified base',
      ),
    },
    options => withRuntimeEffect(config => runGraphShareJoinCommand(config, options)),
  ).pipe(Command.withDescription('Trust an enrolled publisher profile for this checkout'));

  const graphShareLeave = Command.make(
    'leave',
    {
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      purge: boolean('purge', 'Leave also clears provenance; this flag is kept for compatibility'),
    },
    options => withRuntimeEffect(config => runGraphShareLeaveCommand(config, options)),
  ).pipe(Command.withDescription('Revoke local graph-sharing consent for this repository'));

  const graphShareStatus = Command.make(
    'status',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory to inspect'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphShareStatusCommand(config, options)),
  ).pipe(Command.withDescription('Report enrollment, trust, and selected shared frontier without printing secrets'));

  const graphShare = Command.make('share').pipe(
    Command.withDescription('Enroll a repository in organization graph sharing and manage local trust'),
    Command.withSubcommands([graphShareInit, graphShareStatus, graphShareJoin, graphShareLeave]),
  );

  const graphPublisherBootstrap = Command.make(
    'bootstrap',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory for signed frontier artifacts'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphPublisherBootstrapCommand(config, options)),
  ).pipe(Command.withDescription('Export, sign, and publish generation-one frontier for the current clean commit'));

  const graphPublisherServe = Command.make(
    'serve',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory for signed frontier artifacts'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      listen: optionalString(
        'listen',
        'Loopback host:port for the live coordinator and digest CAS (for example 127.0.0.1:18765)',
      ),
    },
    options => withRuntimeEffect(config => runGraphPublisherServeCommand(config, options)),
  ).pipe(
    Command.withDescription(
      'Observe HEAD, publish the next signed generation when it advances, and optionally listen for contributors',
    ),
  );

  const graphPublisherStatus = Command.make(
    'status',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory to inspect'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphPublisherStatusCommand(config, options)),
  ).pipe(Command.withDescription('Report publisher enrollment and the last signed frontier pointer'));

  const graphPublisher = Command.make('publisher').pipe(
    Command.withDescription('Publish signed shared graph checkpoints for enrolled repositories'),
    Command.withSubcommands([graphPublisherBootstrap, graphPublisherServe, graphPublisherStatus]),
  );

  const graphContributeStatus = Command.make(
    'status',
    {
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphContributeStatusCommand(config, options)),
  ).pipe(Command.withDescription('Report local graph contribution mode without printing secrets'));

  const graphContributeSet = Command.make(
    'set',
    {
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      mode: requiredChoice('mode', ['off', 'passive', 'idle', 'dedicated'], 'Contribution mode'),
    },
    options => withRuntimeEffect(config => runGraphContributeSetCommand(config, options)),
  ).pipe(Command.withDescription('Set local graph contribution below the organization maximum'));

  const graphContribute = Command.make('contribute').pipe(
    Command.withDescription('Control opportunistic graph-sharing contribution from this checkout'),
    Command.withSubcommands([graphContributeStatus, graphContributeSet]),
  );

  const graphWorker = Command.make(
    'worker',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory for worker results'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphWorkerCommand(config, options)),
  ).pipe(
    Command.withDescription(
      'Run a dedicated graph worker against the authorized Git checkout; never fetch source from graph CAS',
    ),
  );

  return {graphContribute, graphPublisher, graphShare, graphWorker};
}
