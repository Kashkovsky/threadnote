import {Command} from 'effect/unstable/cli';
import type {Effect} from 'effect';
import {boolean, optionalString, requiredChoice} from '../../effect/cli_flags.js';
import {codeGraphCliBounds} from '../../effect/code_graph_cli_flags.js';
import type {RuntimeConfig} from '../../types.js';
import {
  runGraphContributeSetCommand,
  runGraphContributeStatusCommand,
  runGraphAuth0ConfigureCommand,
  runGraphAuth0LoginCommand,
  runGraphAuth0LogoutCommand,
  runRegistryAuth0ConfigureCommand,
  runRegistryAuth0LoginCommand,
  runRegistryAuth0LogoutCommand,
  runGraphPublisherBootstrapCommand,
  runGraphPublisherProfilePromoteCommand,
  runGraphPublisherServeCommand,
  runGraphPublisherStatusCommand,
  runGraphShareInitCommand,
  runGraphShareJoinCommand,
  runGraphShareLeaveCommand,
  runGraphShareStatusCommand,
  runGraphWorkerCommand,
} from './commands.js';
import {requiredString} from '../../effect/cli_flags.js';

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
      registry: optionalString('registry', 'Canonical OCI repository for an administrator-staged profile'),
      workerRegistry: optionalString(
        'worker-registry',
        'Distinct worker OCI repository for an administrator-staged profile',
      ),
      writeConfig: boolean('write-config', 'Write .threadnote/graph-share.json in the repository'),
    },
    options => withRuntimeEffect(config => runGraphShareInitCommand(config, options)),
  ).pipe(Command.withDescription('Issue a digest-pinned organization profile and optional enrollment pointer'));

  const graphShareJoin = Command.make(
    'join',
    {
      approvalFile: optionalString(
        'approval-file',
        'Private administrator-approved OCI trust and contribution policy file outside the checkout',
      ),
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
  ).pipe(Command.withDescription('Prepare an initial signed frontier or retry publication of the existing generation'));

  const graphPublisherServe = Command.make(
    'serve',
    {
      authorizationPolicy: optionalString(
        'authorization-policy',
        'Policy file for authenticated graph control; signed worker results require distinct OCI registries; disables HTTP artifact routes',
      ),
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

  const graphPublisherProfilePromote = Command.make(
    'profile-promote',
    {
      cas: optionalString('cas', 'Persisted CAS directory containing the staged v1 profile'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      registry: requiredString('registry', 'Exact canonical OCI registry reference; publisher M2M push is required'),
    },
    options => withRuntimeEffect(config => runGraphPublisherProfilePromoteCommand(config, options)),
  ).pipe(Command.withDescription('Publish and verify a staged profile, then print a v2 enrollment candidate'));

  const graphPublisherStatus = Command.make(
    'status',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory to inspect'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphPublisherStatusCommand(config, options)),
  ).pipe(Command.withDescription('Report local signed candidates and confirmed or pending registry publication'));

  const graphPublisher = Command.make('publisher').pipe(
    Command.withDescription('Publish signed shared graph checkpoints for enrolled repositories'),
    Command.withSubcommands([
      graphPublisherBootstrap,
      graphPublisherProfilePromote,
      graphPublisherServe,
      graphPublisherStatus,
    ]),
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
  ).pipe(Command.withDescription('Set local contribution preference; idle and dedicated currently deliver passively'));

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
  ).pipe(Command.withDescription('Report which advertised Git blobs exist locally without executing actions'));

  const graphAuth0Configure = Command.make(
    'configure',
    {
      audience: requiredString('audience', 'Stable graph API audience registered with Auth0'),
      clientId: requiredString('client-id', 'Public Auth0 Native application client ID'),
      coordinatorUrl: requiredString('coordinator', 'Exact HTTPS graph coordinator URL'),
      issuer: requiredString('issuer', 'Exact Auth0 tenant issuer URL'),
      organization: requiredString('organization', 'Graph organization identity'),
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphAuth0ConfigureCommand(config, options)),
  ).pipe(Command.withDescription('Bind an Auth0 public Native client to this organization graph'));

  const graphAuthSelection = {
    coordinatorUrl: optionalString('coordinator', 'Select one configured graph coordinator when multiple are present'),
    organization: optionalString('organization', 'Select one configured graph organization when multiple are present'),
  };
  const graphAuth0Login = Command.make('login', graphAuthSelection, options =>
    withRuntimeEffect(config => runGraphAuth0LoginCommand(config, options)),
  ).pipe(
    Command.withDescription(
      'Authorize graph use once with Auth0 Device Flow and save rotating credentials in macOS Keychain',
    ),
  );

  const graphAuth0Logout = Command.make('logout', graphAuthSelection, options =>
    withRuntimeEffect(config => runGraphAuth0LogoutCommand(config, options)),
  ).pipe(Command.withDescription('Remove the saved local Auth0 graph session from macOS Keychain'));

  const registryAuth0Configure = Command.make(
    'configure',
    {
      audience: requiredString('audience', 'Exact registry API audience; must equal the Zot HTTPS origin'),
      clientId: requiredString('client-id', 'Public Auth0 Native application client ID'),
      issuer: requiredString('issuer', 'Exact Auth0 tenant issuer URL'),
      organization: requiredString('organization', 'Registry organization identity'),
      origin: requiredString('origin', 'Exact Zot HTTPS origin'),
      subject: requiredString('subject', 'Exact Auth0 reader subject admitted by Zot'),
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runRegistryAuth0ConfigureCommand(config, options)),
  ).pipe(Command.withDescription('Bind a separate Auth0 Native registry reader audience to this organization'));
  const registryAuthSelection = {
    origin: optionalString('origin', 'Select one configured Zot registry origin when multiple are present'),
    organization: optionalString(
      'organization',
      'Select one configured registry organization when multiple are present',
    ),
  };
  const registryAuth0Login = Command.make('login', registryAuthSelection, options =>
    withRuntimeEffect(config => runRegistryAuth0LoginCommand(config, options)),
  ).pipe(Command.withDescription('Authorize read-only Zot access with Auth0 Device Flow and macOS Keychain'));
  const registryAuth0Logout = Command.make('logout', registryAuthSelection, options =>
    withRuntimeEffect(config => runRegistryAuth0LogoutCommand(config, options)),
  ).pipe(Command.withDescription('Remove the saved local Zot reader session from macOS Keychain'));
  const registryAuth = Command.make('registry').pipe(
    Command.withDescription('Set up user-delegated Auth0 credentials for Zot registry reads'),
    Command.withSubcommands([registryAuth0Configure, registryAuth0Login, registryAuth0Logout]),
  );

  const graphAuth = Command.make('auth').pipe(
    Command.withDescription('Set up user-delegated Auth0 credentials for organization graphs'),
    Command.withSubcommands([graphAuth0Configure, graphAuth0Login, graphAuth0Logout, registryAuth]),
  );

  return {graphAuth, graphContribute, graphPublisher, graphShare, graphWorker};
}
