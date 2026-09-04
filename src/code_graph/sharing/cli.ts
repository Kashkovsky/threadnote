import {Command} from 'effect/unstable/cli';
import type {Effect} from 'effect';
import {boolean, optionalString} from '../../effect/cli_flags.js';
import {codeGraphCliBounds} from '../../effect/code_graph_cli_flags.js';
import type {RuntimeConfig} from '../../types.js';
import {
  runGraphPublisherBootstrapCommand,
  runGraphPublisherServeCommand,
  runGraphPublisherStatusCommand,
  runGraphShareInitCommand,
  runGraphShareJoinCommand,
  runGraphShareLeaveCommand,
  runGraphShareStatusCommand,
} from './commands.js';

export function makeGraphSharingCommands(
  withRuntimeEffect: <E, R>(effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const graphShareInit = Command.make(
    'init',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory for organization-issued profiles'),
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
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      readOnly: boolean('read-only', 'Download verified shared bases without enabling contribution'),
    },
    options => withRuntimeEffect(config => runGraphShareJoinCommand(config, options)),
  ).pipe(Command.withDescription('Trust an enrolled publisher profile for this checkout'));

  const graphShareLeave = Command.make(
    'leave',
    {
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      purge: boolean('purge', 'Remove local shared-base provenance for this checkout'),
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
    },
    options => withRuntimeEffect(config => runGraphPublisherServeCommand(config, options)),
  ).pipe(Command.withDescription('Publish generation-one frontier; continuous watch lands in a later phase'));

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

  return {graphPublisher, graphShare};
}
