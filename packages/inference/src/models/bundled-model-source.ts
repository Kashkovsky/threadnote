import {Effect} from 'effect';
import {fromPromise} from '@threadnote/platform/errors';

export type BundledModelSourceExtractor = (
  sourcePath: string,
  destinationPath: string,
) => Effect.Effect<number, unknown>;

export const extractBundledModelSource: BundledModelSourceExtractor = Effect.fn('models.extractBundledModelSource')(
  (sourcePath, destinationPath) =>
    fromPromise('extract bundled model', () => Bun.write(destinationPath, Bun.file(sourcePath))),
);
