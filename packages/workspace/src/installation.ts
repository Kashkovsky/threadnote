import {Effect, FileSystem, Path} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';

export const toolRoot = Effect.fn('utils.toolRoot')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  if (typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE) {
    const system = yield* SystemInfo;
    return pathService.dirname(system.executablePath);
  }
  const modulePath = yield* pathService.fromFileUrl(new URL(import.meta.url));
  const moduleDirectory = pathService.dirname(modulePath);
  return (yield* fs.exists(pathService.join(moduleDirectory, 'package.json')))
    ? moduleDirectory
    : pathService.resolve(moduleDirectory, '..', '..', '..');
});
