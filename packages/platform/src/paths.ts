import {Effect, Path} from 'effect';
import {SystemInfo} from './system.js';

export function assertSafeRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)
  ) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }
  return relativePath;
}

export const expandPath = Effect.fn('utils.expandPath')(function* (path: string) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  if (path === '~') {
    return system.homeDirectory;
  }
  if (path.startsWith(`~${pathService.sep}`) || path.startsWith('~/')) {
    return pathService.join(system.homeDirectory, path.slice(2));
  }
  return pathService.isAbsolute(path) ? path : pathService.resolve(yield* getInvocationCwd(), path);
});

export const getInvocationCwd = Effect.fn('utils.getInvocationCwd')(function* () {
  const system = yield* SystemInfo;
  return system.environment().THREADNOTE_CALLER_CWD ?? system.currentDirectory();
});
