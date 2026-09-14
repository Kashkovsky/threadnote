import {Console, Effect} from 'effect';
import {writeFinalCliOutput} from '../../effect/cli_output.js';
import type {RuntimeConfig} from '../../types.js';
import {graphSharingFailure} from './errors.js';
import {
  configureGraphAuth0User,
  configureRegistryAuth0User,
  loginGraphAuth0User,
  loginRegistryAuth0User,
  logoutGraphAuth0User,
  logoutRegistryAuth0User,
} from './auth0_user.js';
import {graphPublisherPublicationMessage, readGraphPublisherRegistryStatus} from './publisher_registry.js';
import {
  runGraphContributeSet,
  runGraphContributeStatus,
  runGraphShareJoin,
  runGraphShareLeave,
  runGraphShareStatus,
  runGraphWorker,
  type GraphShareContributeSetOptions,
  type GraphShareContributeStatusOptions,
  type GraphShareJoinOptions,
  type GraphShareLeaveOptions,
  type GraphShareStatusOptions,
  type GraphWorkerOptions,
} from './client.js';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherListen,
  runGraphPublisherProfilePromote,
  runGraphPublisherServe,
  runGraphShareInit,
  type GraphPublisherBootstrapOptions,
  type GraphPublisherProfilePromoteOptions,
  type GraphShareInitOptions,
} from './publisher.js';

export const runGraphShareInitCommand = Effect.fn('codeGraph.sharing.initCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareInitOptions,
) {
  const result = yield* runGraphShareInit(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    options.registry !== undefined
      ? result.written
        ? `Wrote temporary local-CAS enrollment ${result.enrollmentPath}. Run graph publisher profile-promote --registry ${options.registry}, then replace this file with the verified v2 candidate before committing.`
        : `Staged local-CAS graph profile ${result.profileDigest}. Run again with --write-config for promotion, then replace the v1 file with the verified v2 candidate before committing.`
      : result.written
        ? `Wrote graph share enrollment ${result.enrollmentPath}`
        : `Graph share enrollment preview ${result.profileDigest}; pass --write-config to write ${result.enrollmentPath}`,
  );
  return result;
});

export const runGraphShareJoinCommand = Effect.fn('codeGraph.sharing.joinCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareJoinOptions,
) {
  const result = yield* runGraphShareJoin(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    `Joined graph sharing (${result.accessMode}) for ${result.organization} at ${result.profileDigest}`,
  );
  return result;
});

export const runGraphShareLeaveCommand = Effect.fn('codeGraph.sharing.leaveCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareLeaveOptions,
) {
  const result = yield* runGraphShareLeave(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(`Left graph sharing for ${result.repositoryId}`);
  return result;
});

export const runGraphShareStatusCommand = Effect.fn('codeGraph.sharing.statusCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareStatusOptions,
) {
  const result = yield* runGraphShareStatus(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    result.enrolled
      ? `Graph sharing enrolled${result.trusted ? `; ${result.accessMode ?? 'trusted'}` : '; not joined'}${
          result.lastImport === undefined ? '' : `; last import ${result.lastImport.reason}`
        }`
      : 'Graph sharing is not enrolled; local graph behavior is unchanged.',
  );
  return result;
});

export const runGraphPublisherBootstrapCommand = Effect.fn('codeGraph.sharing.publisherBootstrapCommand')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions,
) {
  const result = yield* runGraphPublisherBootstrap(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(graphPublisherPublicationMessage(result));
  return result;
});

export const runGraphPublisherProfilePromoteCommand = Effect.fn('codeGraph.sharing.publisherProfilePromoteCommand')(
  function* (config: RuntimeConfig, options: GraphPublisherProfilePromoteOptions) {
    const result = yield* runGraphPublisherProfilePromote(config, options);
    const candidate = JSON.stringify(result.enrollment, undefined, 2);
    if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
    else
      yield* Console.log(
        `Verified OCI profile artifact. Review this candidate enrollment; no repository file was changed:\n${candidate}`,
      );
    return result;
  },
);

export const runGraphPublisherServeCommand = Effect.fn('codeGraph.sharing.publisherServeCommand')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions,
) {
  if (options.authorizationPolicy !== undefined && !options.listen?.trim()) {
    return yield* graphSharingFailure('Graph control authorization requires --listen.');
  }
  if (options.listen !== undefined && options.listen.trim().length > 0) {
    return yield* runGraphPublisherListen(config, {
      ...options,
      listen: options.listen,
      onReady: output => writeFinalCliOutput(JSON.stringify(output)),
    });
  }
  const result = yield* runGraphPublisherServe(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(graphPublisherPublicationMessage(result));
  return result;
});

export const runGraphContributeStatusCommand = Effect.fn('codeGraph.sharing.contributeStatusCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareContributeStatusOptions,
) {
  const result = yield* runGraphContributeStatus(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    `Graph contribution mode ${result.mode}${result.requestedMode === result.mode ? '' : ` (requested ${result.requestedMode})`}`,
  );
  if (result.resourcePolicy?.verification === 'unavailable')
    yield* Console.log('Trusted organization profile is unavailable; contribution uploads fail closed.');
  else if (result.resourcePolicy?.deliveryPausedReason === 'organization-upload-disabled')
    yield* Console.log('Organization profile disables contribution uploads (0 bytes/second).');
  else if (result.resourcePolicy !== undefined && result.mode !== 'off')
    yield* Console.log(
      `Organization upload limit ${result.resourcePolicy.declaredMaximumUploadBytesPerSecond} bytes/second is declared but not enforced; active resource limits are not enforced.`,
    );
  return result;
});

export const runGraphContributeSetCommand = Effect.fn('codeGraph.sharing.contributeSetCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareContributeSetOptions,
) {
  const result = yield* runGraphContributeSet(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    `Set graph contribution mode ${result.mode}${result.requestedMode === result.mode ? '' : ` (requested ${result.requestedMode})`}`,
  );
  return result;
});

export const runGraphWorkerCommand = Effect.fn('codeGraph.sharing.workerCommand')(function* (
  config: RuntimeConfig,
  options: GraphWorkerOptions,
) {
  const result = yield* runGraphWorker(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    `Advertised Git blobs present ${result.eligible}; missing ${result.skippedMissingBlob}; no work executed`,
  );
  return result;
});

export const runGraphPublisherStatusCommand = Effect.fn('codeGraph.sharing.publisherStatusCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareStatusOptions,
) {
  const result = yield* readGraphPublisherRegistryStatus(config, options);
  if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
  else
    yield* Console.log(
      !result.enrolled
        ? 'Repository is not enrolled for graph publication.'
        : result.localCandidate === undefined || result.publication === undefined
          ? 'No local signed frontier has been prepared.'
          : graphPublisherPublicationMessage({...result.localCandidate, publication: result.publication}),
    );
  return result;
});

export const runGraphAuth0ConfigureCommand = Effect.fn('codeGraph.sharing.auth0ConfigureCommand')(function* (
  config: RuntimeConfig,
  options: {
    readonly audience: string;
    readonly clientId: string;
    readonly coordinatorUrl: string;
    readonly issuer: string;
    readonly organization: string;
    readonly json: boolean;
  },
) {
  const result = yield* configureGraphAuth0User(config, {
    audience: options.audience,
    clientId: options.clientId,
    coordinatorUrl: options.coordinatorUrl,
    issuer: options.issuer,
    organization: options.organization,
  });
  if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
  else yield* Console.log('Configured the public Auth0 graph client. Run `threadnote graph auth login` once.');
});

export const runGraphAuth0LoginCommand = Effect.fn('codeGraph.sharing.auth0LoginCommand')(function* (
  config: RuntimeConfig,
  options: {readonly coordinatorUrl?: string; readonly organization?: string},
) {
  if ((options.coordinatorUrl === undefined) !== (options.organization === undefined))
    return yield* graphSharingFailure('Specify both --coordinator and --organization.');
  const selector =
    options.coordinatorUrl === undefined || options.organization === undefined
      ? undefined
      : {coordinatorUrl: options.coordinatorUrl, organization: options.organization};
  yield* loginGraphAuth0User(config.agentContextHome, undefined, selector);
  yield* Console.log('Graph Auth0 login complete. Background graph contributions can refresh silently.');
});

export const runGraphAuth0LogoutCommand = Effect.fn('codeGraph.sharing.auth0LogoutCommand')(function* (
  config: RuntimeConfig,
  options: {readonly coordinatorUrl?: string; readonly organization?: string},
) {
  if ((options.coordinatorUrl === undefined) !== (options.organization === undefined))
    return yield* graphSharingFailure('Specify both --coordinator and --organization.');
  const selector =
    options.coordinatorUrl === undefined || options.organization === undefined
      ? undefined
      : {coordinatorUrl: options.coordinatorUrl, organization: options.organization};
  yield* logoutGraphAuth0User(config.agentContextHome, undefined, selector);
  yield* Console.log('Removed the local Graph Auth0 session. Run `threadnote graph auth login` to reconnect.');
});

export const runRegistryAuth0ConfigureCommand = Effect.fn('codeGraph.sharing.registryAuth0ConfigureCommand')(function* (
  config: RuntimeConfig,
  options: {
    readonly audience: string;
    readonly clientId: string;
    readonly issuer: string;
    readonly organization: string;
    readonly origin: string;
    readonly subject: string;
    readonly json: boolean;
  },
) {
  const result = yield* configureRegistryAuth0User(config, options);
  if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
  else
    yield* Console.log('Configured the public Auth0 registry reader. Run `threadnote graph auth registry login` once.');
});

export const runRegistryAuth0LoginCommand = Effect.fn('codeGraph.sharing.registryAuth0LoginCommand')(function* (
  config: RuntimeConfig,
  options: {readonly origin?: string; readonly organization?: string},
) {
  if ((options.origin === undefined) !== (options.organization === undefined))
    return yield* graphSharingFailure('Specify both --origin and --organization.');
  const selector =
    options.origin === undefined || options.organization === undefined
      ? undefined
      : {coordinatorUrl: options.origin, organization: options.organization};
  yield* loginRegistryAuth0User(config.agentContextHome, undefined, selector);
  yield* Console.log('Registry Auth0 login complete. Verified registry reads can refresh silently.');
});

export const runRegistryAuth0LogoutCommand = Effect.fn('codeGraph.sharing.registryAuth0LogoutCommand')(function* (
  config: RuntimeConfig,
  options: {readonly origin?: string; readonly organization?: string},
) {
  if ((options.origin === undefined) !== (options.organization === undefined))
    return yield* graphSharingFailure('Specify both --origin and --organization.');
  const selector =
    options.origin === undefined || options.organization === undefined
      ? undefined
      : {coordinatorUrl: options.origin, organization: options.organization};
  yield* logoutRegistryAuth0User(config.agentContextHome, undefined, selector);
  yield* Console.log(
    'Removed the local registry Auth0 session. Run `threadnote graph auth registry login` to reconnect.',
  );
});
