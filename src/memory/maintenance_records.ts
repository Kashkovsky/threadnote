import {Effect, FileSystem, Path, PlatformError, Result, Schema} from 'effect';
import {
  inspectContainedStableRegularFile,
  readBoundedContainedStableRegularFile,
} from '../code_graph/inventory_contained_file.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {scanFilesWithinBoundary} from '../effect/safe_scan.js';
import {uriSegment} from '../manifest.js';
import {validatePortableSegment} from '../storage/resource-id.js';
import type {MemoryKind, MemoryStatus, RuntimeConfig} from '../types.js';
import {parseMemoryDocument, type MemoryRecord} from './document.js';
import {localUserMemoriesRoot} from './migrations.js';

const MAINTENANCE_READ_CONCURRENCY = 16;
const PERSONAL_PROJECT_FILE_LIMIT = 10_000;
const PERSONAL_PROJECT_FILE_BYTE_LIMIT = 8 * 1_024 * 1_024;
const PERSONAL_PROJECT_TOTAL_BYTE_LIMIT = 128 * 1_024 * 1_024;

class PersonalProjectReadError extends Schema.TaggedError<PersonalProjectReadError>()('PersonalProjectReadError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/** Read canonical active records for one project without synchronizing or mutating storage. */
export const readActiveProjectMemoryRecords = Effect.fn('memory.readActiveProjectRecords')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const records = yield* readMaintenanceMemoryRecords(config);
  return records.filter(record => record.metadata.status === 'active' && record.metadata.project === project);
});

/** Read active personal records without including local copies of shared team memories. */
export const readActivePersonalProjectMemoryRecords = Effect.fn('memory.readActivePersonalProjectRecords')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const records = yield* readPersonalProjectMemoryRecords(config, project);
  return records.filter(record => record.metadata.status === 'active');
});

export const readPersonalProjectMemoryRecords = Effect.fn('memory.readPersonalProjectRecords')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const records: MemoryRecord[] = [];
  const directorySnapshots: Array<{readonly directory: string; readonly entries: readonly string[] | undefined}> = [];
  const selectedEntries: Array<{
    readonly location: PersonalProjectLocation;
    readonly name: string;
    readonly relative: string;
  }> = [];
  const admittedEntries: Array<{
    readonly location: PersonalProjectLocation;
    readonly name: string;
    readonly relative: string;
    readonly size: number;
  }> = [];
  const selectedFiles: Array<{readonly contentHash: string; readonly relative: string}> = [];
  let canonicalRoot: string | undefined;
  let filesRead = 0;
  let inspectedBytes = 0;
  let bytesRead = 0;
  for (const location of personalProjectLocations(uriSegment(project))) {
    const directory = path.join(root, ...location.relativeDirectory);
    const before = yield* canonicalDirectoryEntries(fs, directory);
    directorySnapshots.push({directory, entries: before});
    if (before === undefined) {
      continue;
    }
    const memoryNames = before.filter(name => name.endsWith('.md'));
    filesRead += memoryNames.length;
    if (filesRead > PERSONAL_PROJECT_FILE_LIMIT) {
      return yield* personalProjectReadError('Personal project memory file limit exceeded.');
    }
    for (const name of memoryNames) {
      const relative = [...location.relativeDirectory, name].join('/');
      selectedEntries.push({location, name, relative});
    }
  }
  if (selectedEntries.length > 0) {
    canonicalRoot = yield* fs.realPath(root);
  }
  for (const selected of selectedEntries) {
    const inspected = yield* inspectContainedStableRegularFile(fs, path, canonicalRoot!, selected.relative);
    if (inspected.size > PERSONAL_PROJECT_FILE_BYTE_LIMIT) {
      return yield* personalProjectReadError('Personal project memory file byte limit exceeded.');
    }
    inspectedBytes += inspected.size;
    if (inspectedBytes > PERSONAL_PROJECT_TOTAL_BYTE_LIMIT) {
      return yield* personalProjectReadError('Personal project memory byte limit exceeded.');
    }
    admittedEntries.push({...selected, size: inspected.size});
  }
  for (const selected of admittedEntries) {
    const bytes = yield* readBoundedContainedStableRegularFile(
      fs,
      path,
      canonicalRoot!,
      selected.relative,
      PERSONAL_PROJECT_FILE_BYTE_LIMIT,
    );
    if (bytes.byteLength !== selected.size) {
      return yield* personalProjectReadError('Personal project memory content changed during the snapshot read.');
    }
    selectedFiles.push({contentHash: sha256HexSync(bytes), relative: selected.relative});
    bytesRead += bytes.byteLength;
    if (bytesRead > PERSONAL_PROJECT_TOTAL_BYTE_LIMIT) {
      return yield* personalProjectReadError('Personal project memory byte limit exceeded.');
    }
    const content = yield* Effect.try({
      try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
      catch: cause => personalProjectReadError('Personal project memory is not valid UTF-8.', cause),
    });
    const uri = `threadnote://user/${uriSegment(config.user)}/memories/${selected.relative}`;
    const record = parseMemoryDocument(uri, content);
    if (
      record === undefined ||
      record.metadata.kind !== selected.location.kind ||
      record.metadata.project !== project ||
      record.metadata.status !== selected.location.status ||
      !selected.location.headerTitles.includes(record.headerTitle) ||
      record.metadata.visibility !== 'personal' ||
      !hasCanonicalPersonalFilename(record, selected.name, selected.location.topicBoundFilename)
    ) {
      return yield* personalProjectReadError(
        `Personal project memory path and metadata do not agree: ${selected.relative}`,
      );
    }
    records.push(record);
  }
  for (const snapshot of directorySnapshots) {
    const after = yield* canonicalDirectoryEntries(fs, snapshot.directory);
    if (
      (snapshot.entries === undefined && after !== undefined) ||
      (snapshot.entries !== undefined && (after === undefined || !sameEntries(snapshot.entries, after)))
    ) {
      return yield* personalProjectReadError('Personal project memory directory changed.');
    }
  }
  if (selectedFiles.length > 0 && canonicalRoot === undefined) {
    return yield* personalProjectReadError('Personal project memory root could not be observed.');
  }
  for (const selected of selectedFiles) {
    const observed = yield* readBoundedContainedStableRegularFile(
      fs,
      path,
      canonicalRoot!,
      selected.relative,
      PERSONAL_PROJECT_FILE_BYTE_LIMIT,
    );
    if (sha256HexSync(observed) !== selected.contentHash) {
      return yield* personalProjectReadError('Personal project memory content changed during the snapshot read.');
    }
  }
  return records.sort((left, right) => left.uri.localeCompare(right.uri));
});

/** Read every canonical memory document for maintenance evidence, including inactive relation targets. */
export const readMaintenanceMemoryRecords = Effect.fn('memory.readMaintenanceRecords')(function* (
  config: RuntimeConfig,
  options: {readonly personalOnly?: boolean} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const files = yield* scanFilesWithinBoundary(fs, root, root, {
    includeDirectory: directory => {
      if (options.personalOnly !== true) return true;
      const relative = path.relative(root, directory);
      return relative.split(path.sep)[0] !== 'shared';
    },
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

interface PersonalProjectLocation {
  readonly headerTitles: readonly MemoryRecord['headerTitle'][];
  readonly kind: Extract<MemoryKind, 'durable' | 'handoff' | 'incident'>;
  readonly relativeDirectory: readonly string[];
  readonly status: MemoryStatus;
  readonly topicBoundFilename: boolean;
}

function personalProjectLocations(project: string): readonly PersonalProjectLocation[] {
  const locations: PersonalProjectLocation[] = [
    {
      headerTitles: ['MEMORY'],
      kind: 'durable',
      relativeDirectory: ['durable', 'projects', project],
      status: 'active',
      topicBoundFilename: true,
    },
    {
      headerTitles: ['HANDOFF'],
      kind: 'handoff',
      relativeDirectory: ['handoffs', 'active', project],
      status: 'active',
      topicBoundFilename: true,
    },
    {
      headerTitles: ['MEMORY'],
      kind: 'incident',
      relativeDirectory: ['incidents', 'active', project],
      status: 'active',
      topicBoundFilename: true,
    },
  ];
  for (const status of ['archived', 'expired', 'superseded'] as const) {
    locations.push(
      {
        headerTitles: ['MEMORY'],
        kind: 'durable',
        relativeDirectory: ['durable', status, project],
        status,
        topicBoundFilename: false,
      },
      {
        // Lifecycle migration preserved HANDOFF while current archival emits MEMORY.
        headerTitles: ['HANDOFF', 'MEMORY'],
        kind: 'handoff',
        relativeDirectory: ['handoffs', status, project],
        status,
        topicBoundFilename: false,
      },
      {
        headerTitles: ['MEMORY'],
        kind: 'incident',
        relativeDirectory: ['incidents', status, project],
        status,
        topicBoundFilename: false,
      },
    );
  }
  return locations;
}

const canonicalDirectoryEntries = Effect.fn('memory.personalProjectDirectoryEntries')(function* (
  fs: FileSystem.FileSystem,
  directory: string,
) {
  const stat = yield* fs.stat(directory).pipe(Effect.result);
  if (Result.isFailure(stat)) {
    if (isNotFound(stat.failure)) return undefined;
    return yield* stat.failure;
  }
  if (stat.success.type !== 'Directory') {
    return yield* personalProjectReadError(`Personal project memory path is not a directory: ${directory}`);
  }
  const link = yield* fs.readLink(directory).pipe(Effect.result);
  if (Result.isSuccess(link)) {
    return yield* personalProjectReadError(`Personal project memory directory is symbolic: ${directory}`);
  }
  if (!isMissingOrNonLink(link.failure)) return yield* link.failure;
  return [...(yield* fs.readDirectory(directory))].sort(compareText);
});

function isNotFound(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === 'NotFound';
}

function isMissingOrNonLink(error: PlatformError.PlatformError): boolean {
  if (isNotFound(error)) return true;
  if (error.reason._tag !== 'Unknown' || !('cause' in error.reason)) return false;
  const cause = error.reason.cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as {readonly code?: unknown}).code === 'EINVAL'
  );
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function hasCanonicalPersonalFilename(record: MemoryRecord, filename: string, topicBound: boolean): boolean {
  if (!filename.endsWith('.md')) return false;
  const basename = filename.slice(0, -'.md'.length);
  const topic = record.metadata.topic;
  try {
    validatePortableSegment(basename, basename);
    if (topic !== undefined) validatePortableSegment(topic, topic);
  } catch {
    return false;
  }
  return !topicBound || (topic !== undefined && filename === `${uriSegment(topic)}.md`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function personalProjectReadError(message: string, cause?: unknown): PersonalProjectReadError {
  return PersonalProjectReadError.make({message, ...(cause === undefined ? {} : {cause})});
}
