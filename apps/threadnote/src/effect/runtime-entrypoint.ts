import {Layer} from 'effect';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';

export const runtimeEntrypointLayer = Layer.succeed(RuntimeEntrypoint, {
  developmentEntrypoint: Bun.fileURLToPath(new URL('../standalone.ts', import.meta.url)),
});
