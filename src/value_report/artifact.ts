import {Effect, FileSystem, Path, Schema} from 'effect';
import {sha256Hex} from '../effect/digest.js';
import {VALUE_REPORT_EXPORT_DIRECTORY, withValueReportStorageLock, removeStaleValueReportStaging} from './storage.js';

export class ValueArtifactError extends Schema.TaggedError<ValueArtifactError>()('ValueArtifactError', {
  message: Schema.String,
}) {}

export const writeValueArtifactUnderLock = Effect.fn('valueReport.writeArtifactUnderLock')(function* (
  agentContextHome: string,
  serialized: string,
  prefix: 'threadnote-value-report-export-v1' | 'threadnote-value-pilot-report-v1',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* removeStaleValueReportStaging(agentContextHome);
  const digest = yield* sha256Hex(serialized);
  const directory = path.join(agentContextHome, ...VALUE_REPORT_EXPORT_DIRECTORY.split('/'));
  const output = path.join(directory, `${prefix}-${digest.slice(0, 24)}.json`);
  if (yield* fs.exists(output)) {
    if ((yield* fs.readFileString(output)) !== serialized)
      return yield* ValueArtifactError.make({message: 'Value export digest conflict.'});
    yield* fs.chmod(directory, 0o700);
    yield* fs.chmod(output, 0o600);
    return output;
  }
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* fs.chmod(directory, 0o700);
  const staging = path.join(directory, `.${prefix}-${digest.slice(0, 24)}.staging`);
  yield* fs.makeDirectory(staging, {mode: 0o700});
  const temporary = path.join(staging, 'report.json');
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, serialized, {mode: 0o600});
    yield* fs.chmod(temporary, 0o600);
    const renamed = yield* fs.rename(temporary, output).pipe(Effect.result);
    if (renamed._tag === 'Success') return;
    if ((yield* fs.exists(output)) && (yield* fs.readFileString(output)) === serialized) return;
    return yield* renamed.failure;
  }).pipe(Effect.ensuring(fs.remove(staging, {force: true, recursive: true}).pipe(Effect.ignore)));
  yield* fs.chmod(output, 0o600);
  return output;
});

export const writeValueArtifact = Effect.fn('valueReport.writeArtifact')(
  (
    home: string,
    serialized: string,
    prefix: 'threadnote-value-report-export-v1' | 'threadnote-value-pilot-report-v1',
  ) => withValueReportStorageLock(home, writeValueArtifactUnderLock(home, serialized, prefix)),
);
