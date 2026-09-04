import {Console, Effect} from 'effect';
import {writeFinalCliOutput} from '../../effect/cli_output.js';
import type {RuntimeConfig} from '../../types.js';
import {
  runGraphShareJoin,
  runGraphShareLeave,
  runGraphShareStatus,
  type GraphShareJoinOptions,
  type GraphShareLeaveOptions,
  type GraphShareStatusOptions,
} from './client.js';
import {
  runGraphPublisherBootstrap,
  runGraphShareInit,
  type GraphPublisherBootstrapOptions,
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
    result.written
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
      ? `Graph sharing enrolled${result.trusted ? `; ${result.accessMode ?? 'trusted'}` : '; not joined'}`
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
  yield* Console.log(`Published generation-one frontier ${result.manifestDigest} for ${result.sourceCommit}`);
  return result;
});

export const runGraphPublisherServeCommand = runGraphPublisherBootstrapCommand;

export const runGraphPublisherStatusCommand = runGraphShareStatusCommand;
