import {Schema} from 'effect';
import {parseValueReportV1, ValueReportV1Schema, type ValueReportV1} from './index.js';

export const VALUE_REPORT_EXPORT_SCHEMA = 'threadnote.value-report-export.v1' as const;
export const VALUE_REPORT_EXPORT_VERSION = 1 as const;

export interface ValueReportExportV1 {
  readonly schema: typeof VALUE_REPORT_EXPORT_SCHEMA;
  readonly type: 'threadnote-value-report-export';
  readonly version: typeof VALUE_REPORT_EXPORT_VERSION;
  readonly report: ValueReportV1;
}

export const ValueReportExportV1Schema = Schema.Struct({
  report: ValueReportV1Schema,
  schema: Schema.Literal(VALUE_REPORT_EXPORT_SCHEMA),
  type: Schema.Literal('threadnote-value-report-export'),
  version: Schema.Literal(VALUE_REPORT_EXPORT_VERSION),
});

const STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;

export function parseValueReportExportV1(value: unknown): ValueReportExportV1 {
  const parsed = Schema.decodeUnknownSync(ValueReportExportV1Schema, STRICT_PARSE_OPTIONS)(value);
  return {...parsed, report: parseValueReportV1(parsed.report)};
}

export function buildValueReportExportV1(report: ValueReportV1): ValueReportExportV1 {
  return canonicalValueReportExport({
    report: parseValueReportV1(report),
    schema: VALUE_REPORT_EXPORT_SCHEMA,
    type: 'threadnote-value-report-export',
    version: VALUE_REPORT_EXPORT_VERSION,
  });
}

export function serializeValueReportExportV1(bundle: ValueReportExportV1): string {
  return JSON.stringify(canonicalValueReportExport(parseValueReportExportV1(bundle)), undefined, 2);
}

function canonicalValueReportExport(bundle: ValueReportExportV1): ValueReportExportV1 {
  const report = bundle.report;
  return {
    schema: bundle.schema,
    type: bundle.type,
    version: bundle.version,
    report: {
      type: report.type,
      version: report.version,
      scope: report.scope,
      period: {from: report.period.from, to: report.period.to},
      contextBrief: {
        attempts: report.contextBrief.attempts,
        successful: report.contextBrief.successful,
        requestedCodeAnchors: report.contextBrief.requestedCodeAnchors,
        resolvedCodeAnchors: report.contextBrief.resolvedCodeAnchors,
        coverageGaps: report.contextBrief.coverageGaps,
        estimatedTokens: report.contextBrief.estimatedTokens,
        followUpGraphOperations: report.contextBrief.followUpGraphOperations,
        followUpRecallOperations: report.contextBrief.followUpRecallOperations,
        followUpOperations: report.contextBrief.followUpOperations,
        ...(report.contextBrief.timeToFirstSuccessfulMilliseconds === undefined
          ? {}
          : {timeToFirstSuccessfulMilliseconds: report.contextBrief.timeToFirstSuccessfulMilliseconds}),
      },
      feedback: {
        dismiss: report.feedback.dismiss,
        pin: report.feedback.pin,
        useful: report.feedback.useful,
        wrong: report.feedback.wrong,
        total: report.feedback.total,
        dismissRate: report.feedback.dismissRate,
        pinRate: report.feedback.pinRate,
        usefulRate: report.feedback.usefulRate,
        wrongRate: report.feedback.wrongRate,
      },
      knowledgeDelta: {
        proposed: report.knowledgeDelta.proposed,
        approved: report.knowledgeDelta.approved,
        edited: report.knowledgeDelta.edited,
        rejected: report.knowledgeDelta.rejected,
        deferred: report.knowledgeDelta.deferred,
      },
      health: {opened: report.health.opened, resolved: report.health.resolved},
      setup: {
        availability: report.setup.availability,
        completed: report.setup.completed,
        failed: report.setup.failed,
        started: report.setup.started,
        supportedAgentReuse: report.setup.supportedAgentReuse,
        ...(report.setup.timeToFirstEvidenceMilliseconds === undefined
          ? {}
          : {timeToFirstEvidenceMilliseconds: report.setup.timeToFirstEvidenceMilliseconds}),
      },
    },
  };
}
