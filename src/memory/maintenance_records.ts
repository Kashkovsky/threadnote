import {Effect, FileSystem, Path} from 'effect';
import {scanFilesWithinBoundary} from '../effect/safe_scan.js';
import {uriSegment} from '../manifest.js';
import type {RuntimeConfig} from '../types.js';
import {parseMemoryDocument, type MemoryRecord} from './document.js';
import {localUserMemoriesRoot} from './migrations.js';

const MAINTENANCE_READ_CONCURRENCY = 16;

/** Read canonical active records for one project without synchronizing or mutating storage. */
export const readActiveProjectMemoryRecords = Effect.fn('memory.readActiveProjectRecords')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const records = yield* readMaintenanceMemoryRecords(config);
  return records.filter(record => record.metadata.status === 'active' && record.metadata.project === project);
});

/** Read every canonical memory document for maintenance evidence, including inactive relation targets. */
export const readMaintenanceMemoryRecords = Effect.fn('memory.readMaintenanceRecords')(function* (
  config: RuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const files = yield* scanFilesWithinBoundary(fs, root, root, {
    includeFile: (_filePath, name) => name.endsWith('.md') && !name.startsWith('.'),
    recursive: true,
  });
  const records = yield* Effect.forEach(
    files,
    file =>
      Effect.gen(function* () {
        const content = yield* fs.readFileString(file.path);
        const relative = path.relative(root, file.path).split(path.sep).join('/');
        return parseMemoryDocument(`threadnote://user/${uriSegment(config.user)}/memories/${relative}`, content);
      }),
    {concurrency: MAINTENANCE_READ_CONCURRENCY},
  );
  return records
    .filter((record): record is MemoryRecord => record !== undefined)
    .sort((left, right) => left.uri.localeCompare(right.uri));
});
