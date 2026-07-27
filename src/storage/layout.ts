import type {Path} from 'effect';
import {validatePortableSegment} from './resource-id.js';

export const THREADNOTE_HOME_DIRECTORY = '.threadnote';
export const LEGACY_OPENVIKING_HOME_DIRECTORY = '.openviking';
export const THREADNOTE_STORAGE_LAYOUT_VERSION = 2 as const;
export const LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION = 1 as const;
export const LEGACY_THREADNOTE_DATA_DIRECTORY = 'viking';

export interface ThreadnoteStorageLayout {
  readonly accountRoot: string;
  readonly cacheRoot: string;
  readonly canonicalRoot: string;
  readonly home: string;
  readonly indexesRoot: string;
  readonly locksRoot: string;
  readonly logsRoot: string;
  readonly migrationRoot: string;
  readonly modelsRoot: string;
  readonly resourcesRoot: string;
  readonly sharesRoot: string;
  readonly temporaryRoot: string;
  readonly userMemoriesRoot: string;
  readonly version: typeof THREADNOTE_STORAGE_LAYOUT_VERSION;
}

export function threadnoteStorageLayout(
  path: Path.Path,
  home: string,
  account: string,
  userSegment: string,
): ThreadnoteStorageLayout {
  validatePortableSegment(account, account);
  validatePortableSegment(userSegment, userSegment);
  const canonicalRoot = path.join(home, 'data');
  const accountRoot = path.join(canonicalRoot, account);
  return {
    accountRoot,
    cacheRoot: path.join(home, 'cache'),
    canonicalRoot,
    home,
    indexesRoot: path.join(home, 'indexes'),
    locksRoot: path.join(home, 'locks'),
    logsRoot: path.join(home, 'logs'),
    migrationRoot: path.join(home, 'migration'),
    modelsRoot: path.join(home, 'models'),
    resourcesRoot: path.join(accountRoot, 'resources'),
    sharesRoot: path.join(home, 'share'),
    temporaryRoot: path.join(home, 'tmp'),
    userMemoriesRoot: path.join(accountRoot, 'user', userSegment, 'memories'),
    version: THREADNOTE_STORAGE_LAYOUT_VERSION,
  };
}
