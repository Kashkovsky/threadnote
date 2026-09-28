import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {describe, expect} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {runImageProjectionCommand} from '@threadnote/threadnote/image_projection/commands';
import {readImageProjectionConfiguration} from '@threadnote/threadnote/image_projection/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {imageProjectionRuntimeConfig} from '@threadnote/workspace/test/helpers/image-projection-runtime-config';

describe('image projection commands', () => {
  effectIt.effect('enables, reports an environment kill switch, and disables immediately', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseSystem = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-image-projection-commands-'});
        const config = imageProjectionRuntimeConfig(home);

        const status = yield* captureConsole(runImageProjectionCommand(config, {disable: false, enable: false}));
        expect(status.output).toContain('disabled (default');
        expect(yield* readImageProjectionConfiguration(config)).toBeUndefined();

        const enabled = yield* captureConsole(runImageProjectionCommand(config, {disable: false, enable: true}));
        expect(enabled.output).toContain('MCP image projection: enabled.');
        expect(enabled.output).toContain('Restart connected MCP clients');
        expect((yield* readImageProjectionConfiguration(config))?.enabled).toBe(true);

        const suppressedSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), THREADNOTE_IMAGE_PROJECTION: '0'}),
        });
        const suppressed = yield* captureConsole(
          runImageProjectionCommand(config, {disable: false, enable: false}),
        ).pipe(Effect.provideService(SystemInfo, suppressedSystem));
        expect(suppressed.output).toContain('disabled by THREADNOTE_IMAGE_PROJECTION');
        expect((yield* readImageProjectionConfiguration(config))?.enabled).toBe(true);

        const disabled = yield* captureConsole(runImageProjectionCommand(config, {disable: true, enable: false}));
        expect(disabled.output).toContain('MCP image projection: disabled.');
        expect((yield* readImageProjectionConfiguration(config))?.enabled).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects combining enable and disable', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-image-projection-conflict-'});
        const result = yield* Effect.result(
          runImageProjectionCommand(imageProjectionRuntimeConfig(home), {disable: true, enable: true}),
        );
        expect(result._tag).toBe('Failure');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
