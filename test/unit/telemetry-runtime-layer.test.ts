import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer} from 'effect';
import {describe, expect} from 'vitest';
import {StandaloneBrokerLayer, telemetryLayerForHomeForTest} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {enabledTelemetryConfiguration, writeTelemetryConfiguration} from '../../src/telemetry/config.js';
import {
  TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE,
  TELEMETRY_CHILD_ENVIRONMENT_VARIABLE,
  TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE,
  TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE,
  TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE,
} from '../../src/telemetry/session.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const SALT = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';

describe('telemetry runtime layer', () => {
  effectIt.effect('builds the private OTLP layer from consent and consumes raw provider correlation input', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-runtime-layer-'});
      const endpoint = 'http://127.0.0.1:4318/v1/traces';
      yield* writeTelemetryConfiguration({agentContextHome: home}, enabledTelemetryConfiguration(endpoint, SALT));
      const environment: NodeJS.ProcessEnv = {
        ...baseSystem.environment(),
        [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
        [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'private-conversation-token',
      };
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => environment,
        setEnvironmentVariable: (name, value) => {
          environment[name] = value;
        },
      });
      const base = Layer.merge(Layer.succeed(SystemInfo, testSystem), BunServices.layer);

      yield* Layer.build(telemetryLayerForHomeForTest(home, 'invocation').pipe(Layer.provide(base)));

      expect(environment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]).toMatch(/^tns_[\da-f]{32}$/u);
      expect(environment[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]).toMatch(/^tng_[\da-f]{32}$/u);
      expect(environment[TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]).not.toContain('private-conversation-token');
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('strips provider correlation input even when telemetry is disabled', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-runtime-disabled-'});
      const environment: NodeJS.ProcessEnv = {
        ...baseSystem.environment(),
        [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
        [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'private-conversation-token',
      };
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => environment,
        setEnvironmentVariable: (name, value) => {
          environment[name] = value;
        },
      });
      const base = Layer.merge(Layer.succeed(SystemInfo, testSystem), BunServices.layer);

      yield* Layer.build(telemetryLayerForHomeForTest(home, 'broker').pipe(Layer.provide(base)));

      expect(environment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]).toBeUndefined();
      expect(environment[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]).toBeUndefined();
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect('fails open to the no-op layer when telemetry setup defects', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-telemetry-runtime-defect-'});
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => {
          throw new Error('telemetry environment defect');
        },
      });
      const base = Layer.merge(Layer.succeed(SystemInfo, testSystem), BunServices.layer);

      const context = yield* Layer.build(telemetryLayerForHomeForTest(home, 'invocation').pipe(Layer.provide(base)));
      expect(context).toBeDefined();
    }).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );
});
