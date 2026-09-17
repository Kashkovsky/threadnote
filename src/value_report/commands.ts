import {DateTime, Effect, Schema} from 'effect';
import {writeFinalCliOutput} from '../effect/cli_output.js';
import {listCandidateReviews} from '../memory/candidate.js';
import {readRecallFeedbackEvents} from '../recall/feedback.js';
import type {RuntimeConfig} from '../types.js';
import {aggregateValueReportV1, type ValueReportV1} from './index.js';
import {readLocalValueEvents, summarizeCandidateReviewValue, summarizeLocalValueEvents} from './events.js';

export const DEFAULT_VALUE_REPORT_PERIOD_DAYS = 30 as const;

export class ValueReportCommandError extends Schema.TaggedError<ValueReportCommandError>()('ValueReportCommandError', {
  message: Schema.String,
}) {}

export interface RunValueReportOptionsV1 {
  readonly json?: boolean;
  readonly period?: number;
  readonly project?: string;
}

export const runValueReport = Effect.fn('valueReport.command')(function* (
  config: RuntimeConfig,
  options: RunValueReportOptionsV1,
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
  yield* writeFinalCliOutput(options.json ? JSON.stringify(report) : renderValueReport(report));
});

function renderValueReport(report: ValueReportV1): string {
  return [
    `Local value report (${report.period.from} to ${report.period.to})`,
    `Feedback: ${report.feedback.total} total; ${report.feedback.useful} useful, ${report.feedback.pin} pinned, ${report.feedback.wrong} wrong, ${report.feedback.dismiss} dismissed.`,
    `Context briefs: ${report.contextBrief.successful}/${report.contextBrief.attempts} successful; ${report.contextBrief.coverageGaps} coverage gap(s).`,
  ].join('\n');
}
