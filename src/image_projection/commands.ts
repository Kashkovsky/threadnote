import {Console, Effect, Result} from 'effect';
import {applicationError} from '../effect/errors.js';
import type {RuntimeConfig} from '../types.js';
import {errorMessage} from '../utils.js';
import {SystemInfo} from '../effect/system.js';
import {
  imageProjectionConfiguration,
  imageProjectionEnvironmentDisabled,
  readImageProjectionConfiguration,
  writeImageProjectionConfiguration,
} from './config.js';

export interface ImageProjectionCommandOptions {
  readonly disable: boolean;
  readonly enable: boolean;
}

export const runImageProjectionCommand = Effect.fn('imageProjection.command')(function* (
  config: RuntimeConfig,
  options: ImageProjectionCommandOptions,
) {
  if (options.enable && options.disable) {
    return yield* applicationError('image-projection', 'Specify only one of --enable or --disable.');
  }
  if (options.enable) {
    yield* writeImageProjectionConfiguration(config, imageProjectionConfiguration(true)).pipe(
      Effect.mapError(cause => applicationError('image-projection', cause)),
    );
    yield* Console.log('MCP image projection: enabled.');
    yield* Console.log('Restart connected MCP clients so they pick up the next read_context result shape.');
    return;
  }
  if (options.disable) {
    yield* writeImageProjectionConfiguration(config, imageProjectionConfiguration(false)).pipe(
      Effect.mapError(cause => applicationError('image-projection', cause)),
    );
    yield* Console.log('MCP image projection: disabled.');
    yield* Console.log('Restart connected MCP clients so they pick up the next read_context result shape.');
    return;
  }
  yield* runImageProjectionStatus(config);
});

const runImageProjectionStatus = Effect.fn('imageProjection.command.status')(function* (config: RuntimeConfig) {
  const system = yield* SystemInfo;
  const loaded = yield* Effect.result(readImageProjectionConfiguration(config));
  if (Result.isFailure(loaded)) {
    yield* Console.log('MCP image projection: disabled (configuration is invalid and fails closed).');
    yield* Console.log(`Configuration error: ${errorMessage(loaded.failure)}`);
    return;
  }
  const enabled = loaded.success?.enabled === true;
  if (!enabled) {
    yield* Console.log('MCP image projection: disabled (default; MCP read_context returns complete text).');
    return;
  }
  if (imageProjectionEnvironmentDisabled(system.environment())) {
    yield* Console.log(
      'MCP image projection: disabled by THREADNOTE_IMAGE_PROJECTION (persisted setting remains enabled).',
    );
    return;
  }
  yield* Console.log('MCP image projection: enabled.');
});
