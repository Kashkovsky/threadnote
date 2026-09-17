import {DateTime, Effect, FileSystem, Path, Schema} from 'effect';
import {writeFinalCliOutput} from '../effect/cli_output.js';
import {sha256Hex} from '../effect/digest.js';
import {listCandidateReviews} from '../memory/candidate.js';
import {readRecallFeedbackEvents} from '../recall/feedback.js';
import type {RuntimeConfig} from '../types.js';
import {buildValueReportExportV1, serializeValueReportExportV1, type ValueReportExportV1} from './export.js';
import {aggregateValueReportV1, type ValueReportV1} from './index.js';
import {readLocalValueEvents, summarizeCandidateReviewValue, summarizeLocalValueEvents} from './events.js';

export const DEFAULT_VALUE_REPORT_PERIOD_DAYS = 30 as const;
export const VALUE_REPORT_EXPORT_DIRECTORY = 'exports/value-reports' as const;

export class ValueReportCommandError extends Schema.TaggedError<ValueReportCommandError>()('ValueReportCommandError', {
  message: Schema.String,
}) {}

export interface RunValueReportOptionsV1 {
  readonly json?: boolean;
  readonly period?: number;
  readonly project?: string;
}

export interface RunValueReportExportOptionsV1 {
  readonly apply?: boolean;
  readonly period?: number;
  readonly project?: string;
}

export const runValueReport = Effect.fn('valueReport.command')(function* (
  config: RuntimeConfig,
  options: RunValueReportOptionsV1,
) {
  const report = yield* buildLocalValueReport(config, options);
  yield* writeFinalCliOutput(options.json ? JSON.stringify(report) : renderValueReport(report));
});

export const runValueReportExport = Effect.fn('valueReport.export.command')(function* (
  config: RuntimeConfig,
  options: RunValueReportExportOptionsV1,
) {
  const report = yield* buildLocalValueReport(config, options);
  const bundle = buildValueReportExportV1(report);
  const serialized = serializeValueReportExportV1(bundle);
  if (options.apply !== true) {
    yield* writeFinalCliOutput(serialized);
    return;
  }
  const outputPath = yield* writeValueReportExport(config.agentContextHome, bundle);
  yield* writeFinalCliOutput(`Exported redacted ValueReportExportV1 to ${outputPath}.`);
});

export const valueReportExportPath = Effect.fn('valueReport.export.path')(function* (
  agentContextHome: string,
  serialized: string,
) {
  const path = yield* Path.Path;
  const digest = yield* sha256Hex(serialized);
  return path.join(
    agentContextHome,
    ...VALUE_REPORT_EXPORT_DIRECTORY.split('/'),
    `threadnote-value-report-export-v1-${digest.slice(0, 24)}.json`,
  );
});

export const writeValueReportExport = Effect.fn('valueReport.export.write')(function* (
  agentContextHome: string,
  bundle: ValueReportExportV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serialized = `${serializeValueReportExportV1(bundle)}\n`;
  const outputPath = yield* valueReportExportPath(agentContextHome, serialized);
  const outputDirectory = path.dirname(outputPath);
  if (yield* fs.exists(outputPath)) {
    const current = yield* fs.readFileString(outputPath);
    if (current !== serialized) {
      return yield* ValueReportCommandError.make({
        message: 'Refusing to replace a value-report export whose content does not match its digest path.',
      });
    }
    yield* fs.chmod(outputDirectory, 0o700);
    yield* fs.chmod(outputPath, 0o600);
    return outputPath;
  }
  yield* fs.makeDirectory(outputDirectory, {recursive: true, mode: 0o700});
  yield* fs.chmod(outputDirectory, 0o700);
  const temporary = yield* fs.makeTempFile({
    directory: outputDirectory,
    prefix: '.threadnote-value-report-export-',
    suffix: '.tmp',
  });
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, serialized, {mode: 0o600});
    yield* fs.chmod(temporary, 0o600);
    const renamed = yield* fs.rename(temporary, outputPath).pipe(Effect.result);
    if (renamed._tag === 'Success') return;
    if ((yield* fs.exists(outputPath)) && (yield* fs.readFileString(outputPath)) === serialized) return;
    return yield* renamed.failure;
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  yield* fs.chmod(outputPath, 0o600);
  return outputPath;
});

const buildLocalValueReport = Effect.fn('valueReport.buildLocal')(function* (
  config: RuntimeConfig,
  options: Pick<RunValueReportOptionsV1, 'period' | 'project'>,
) {
  const periodDays = options.period ?? DEFAULT_VALUE_REPORT_PERIOD_DAYS;
  if (!Number.isSafeInteger(periodDays) || periodDays < 1) {
    return yield* ValueReportCommandError.make({
      message: 'Value report --period must be a positive whole number of days.',
    });
  }
  const now = yield* DateTime.now;
  const [feedbackEvents, valueEvents, candidateReviews] = yield* Effect.all(
    [
      readRecallFeedbackEvents(config.agentContextHome),
      readLocalValueEvents(config.agentContextHome),
      listCandidateReviews(config.agentContextHome),
    ],
    {concurrency: 3},
  );
  const project = options.project?.trim();
  const from = DateTime.makeUnsafe(DateTime.toDateUtc(now).getTime() - periodDays * 86_400_000);
  const period = {from: DateTime.formatIso(from), to: DateTime.formatIso(now)};
  const range = {from: DateTime.toDateUtc(from), ...(project ? {project} : {}), to: DateTime.toDateUtc(now)};
  const eventCounts = summarizeLocalValueEvents(valueEvents, range);
  const report = aggregateValueReportV1({
    counts: {
      ...eventCounts,
      knowledgeDelta: summarizeCandidateReviewValue(candidateReviews, range),
    },
    feedbackEvents,
    period,
    ...(project ? {project} : {}),
  });
  return report;
});

function renderValueReport(report: ValueReportV1): string {
  return [
    `Local value report (${report.period.from} to ${report.period.to})`,
    `Feedback: ${report.feedback.total} total; ${report.feedback.useful} useful, ${report.feedback.pin} pinned, ${report.feedback.wrong} wrong, ${report.feedback.dismiss} dismissed.`,
    `Context briefs: ${report.contextBrief.successful}/${report.contextBrief.attempts} successful; ${report.contextBrief.coverageGaps} coverage gap(s).`,
  ].join('\n');
}
