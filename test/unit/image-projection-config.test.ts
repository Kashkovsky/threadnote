import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {
  ImageProjectionConfigurationError,
  imageProjectionConfiguration,
  imageProjectionEnvironmentDisabled,
  isImageProjectionEnabled,
  parseImageProjectionConfiguration,
  readImageProjectionConfiguration,
  renderImageProjectionConfiguration,
  writeImageProjectionConfiguration,
} from '../../src/image_projection/config.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('image projection configuration', () => {
  it('round-trips enabled and disabled documents and rejects extra fields', () => {
    fc.assert(
      fc.property(fc.boolean(), enabled => {
        const value = imageProjectionConfiguration(enabled);
        expect(parseImageProjectionConfiguration(renderImageProjectionConfiguration(value))).toEqual(value);
      }),
    );
    for (const malformed of [
      {},
      {enabled: true},
      {enabled: 'yes', version: 1},
      {enabled: true, extra: true, version: 1},
      {enabled: true, version: 2},
      {enabled: true, version: 1, unexpected: 1},
    ]) {
      expect(() => parseImageProjectionConfiguration(JSON.stringify(malformed))).toThrow(
        ImageProjectionConfigurationError,
      );
    }
  });

  it('treats THREADNOTE_IMAGE_PROJECTION kill-switch values as disabled', () => {
    expect(imageProjectionEnvironmentDisabled({})).toBe(false);
    expect(imageProjectionEnvironmentDisabled({THREADNOTE_IMAGE_PROJECTION: '1'})).toBe(false);
    for (const value of ['0', 'off', 'false', 'no', 'OFF']) {
      expect(imageProjectionEnvironmentDisabled({THREADNOTE_IMAGE_PROJECTION: value})).toBe(true);
    }
  });

  effectIt.effect('persists enablement, fails closed on invalid files, and honors the env kill switch', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-image-projection-config-'});
        const config = runtimeConfig(home);
        expect(yield* readImageProjectionConfiguration(config)).toBeUndefined();
        expect(yield* isImageProjectionEnabled(config)).toBe(false);

        yield* writeImageProjectionConfiguration(config, imageProjectionConfiguration(true));
        expect(yield* readImageProjectionConfiguration(config)).toEqual(imageProjectionConfiguration(true));
        expect(yield* isImageProjectionEnabled(config)).toBe(true);

        const suppressed = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_IMAGE_PROJECTION: 'off'}),
        });
        expect(yield* isImageProjectionEnabled(config).pipe(Effect.provideService(SystemInfo, suppressed))).toBe(false);

        yield* fs.writeFileString(path.join(home, 'image-projection', 'config.json'), '{not-json}\n');
        const invalid = yield* Effect.result(readImageProjectionConfiguration(config));
        expect(invalid._tag).toBe('Failure');
        expect(yield* isImageProjectionEnabled(config)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function runtimeConfig(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: `${agentContextHome}/manifest.yaml`,
    user: 'tester',
  };
}
