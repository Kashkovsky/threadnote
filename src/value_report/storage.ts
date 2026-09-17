import {Effect, FileSystem, Path} from 'effect';
import {
  clearRecallFeedbackEvents,
  pruneRecallFeedbackEvents,
  type RecallFeedbackStorageResultV1,
} from '../recall/feedback.js';
import {clearLocalValueEvents, pruneLocalValueEvents, type LocalValueEventStorageResultV1} from './events.js';

export const VALUE_REPORT_STORAGE_VERSION = 1 as const;
export const VALUE_REPORT_STORAGE_DELETE_BATCH_SIZE = 10_000 as const;
export const VALUE_REPORT_EXPORT_DIRECTORY = 'exports/value-reports' as const;
const VALUE_REPORT_EXPORT_FILENAME = /^threadnote-value-report-export-v1-[0-9a-f]{24}\.json$/u;

export interface ValueReportRetentionReceiptV1 {
  readonly applied: boolean;
  readonly feedback: RecallFeedbackStorageResultV1;
  readonly retentionDays: number;
  readonly type: 'value-report-retention';
  readonly valueEvents: LocalValueEventStorageResultV1;
  readonly version: typeof VALUE_REPORT_STORAGE_VERSION;
}

export interface ValueReportDeletionReceiptV1 {
  readonly applied: boolean;
  readonly exports: {readonly removed: number; readonly selected: boolean};
  readonly feedback: RecallFeedbackStorageResultV1 & {readonly selected: boolean};
  readonly type: 'value-report-deletion';
  readonly valueEvents: LocalValueEventStorageResultV1 & {readonly selected: boolean};
  readonly version: typeof VALUE_REPORT_STORAGE_VERSION;
}

export const pruneValueReportData = Effect.fn('valueReport.pruneData')(function* (
  agentContextHome: string,
  input: {readonly apply: boolean; readonly now: Date; readonly retentionDays: number},
) {
  const [feedback, valueEvents] = yield* Effect.all(
    [pruneRecallFeedbackEvents(agentContextHome, input), pruneLocalValueEvents(agentContextHome, input)],
    {concurrency: 2},
  );
  return {
    applied: input.apply,
    feedback,
    retentionDays: input.retentionDays,
    type: 'value-report-retention',
    valueEvents,
    version: VALUE_REPORT_STORAGE_VERSION,
  } satisfies ValueReportRetentionReceiptV1;
});

export const deleteValueReportData = Effect.fn('valueReport.deleteData')(function* (
  agentContextHome: string,
  input: {
    readonly apply: boolean;
    readonly exports: boolean;
    readonly feedback: boolean;
    readonly valueEvents: boolean;
  },
) {
  const [feedback, valueEvents, exportsRemoved] = yield* Effect.all(
    [
      input.feedback
        ? clearRecallFeedbackEvents(agentContextHome, input.apply)
        : Effect.succeed({after: 0, applied: input.apply, before: 0, removed: 0}),
      input.valueEvents
        ? clearLocalValueEvents(agentContextHome, input.apply)
        : Effect.succeed({after: 0, applied: input.apply, before: 0, removed: 0}),
      input.exports ? deleteValueReportExports(agentContextHome, input.apply) : Effect.succeed(0),
    ],
    {concurrency: 3},
  );
  return {
    applied: input.apply,
    exports: {removed: exportsRemoved, selected: input.exports},
    feedback: {...feedback, selected: input.feedback},
    type: 'value-report-deletion',
    valueEvents: {...valueEvents, selected: input.valueEvents},
    version: VALUE_REPORT_STORAGE_VERSION,
  } satisfies ValueReportDeletionReceiptV1;
});

const deleteValueReportExports = Effect.fn('valueReport.deleteExports')(function* (
  agentContextHome: string,
  apply: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(agentContextHome, ...VALUE_REPORT_EXPORT_DIRECTORY.split('/'));
  if (!(yield* fs.exists(directory))) return 0;
  const names = selectValueReportExportNames(yield* fs.readDirectory(directory));
  if (apply) {
    for (let offset = 0; offset < names.length; offset += VALUE_REPORT_STORAGE_DELETE_BATCH_SIZE) {
      yield* Effect.forEach(
        names.slice(offset, offset + VALUE_REPORT_STORAGE_DELETE_BATCH_SIZE),
        name => fs.remove(path.join(directory, name), {force: true}),
        {concurrency: 16, discard: true},
      );
    }
  }
  return names.length;
});

export function selectValueReportExportNames(names: readonly string[]): readonly string[] {
  return names.filter(name => VALUE_REPORT_EXPORT_FILENAME.test(name)).sort();
}
