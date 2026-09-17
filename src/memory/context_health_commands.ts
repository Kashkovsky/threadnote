import {DateTime, Effect} from 'effect';
import {writeFinalCliOutput} from '../effect/cli_output.js';
import {SystemInfo} from '../effect/system.js';
import {validateContextBriefMemoryCitations} from '../context_brief/citation_validation.js';
import type {ContextBriefMemoryCandidateV1} from '../context_brief/types.js';
import type {RuntimeConfig} from '../types.js';
import {uriSegment} from '../manifest.js';
import {classifyMemoryIdentityCandidates} from '../recall/memory_identity.js';
import {recordHealthValueSnapshot} from '../value_report/events.js';
import {listCandidateReviews} from './candidate.js';
import {
  buildContextHealthReport,
  type ContextHealthCandidateEvidenceV1,
  type ContextHealthRelationEvidenceV1,
} from './context_health.js';
import {readActiveProjectMemoryRecords, readMaintenanceMemoryRecords} from './maintenance_records.js';
import {memoryIdFromIdentityAlias} from './identity_alias.js';
import {MemoryOperationError} from './migrations.js';
import {guidanceHealthEvidence} from '../guidance/index.js';

export interface RunContextHealthOptionsV1 {
  readonly json?: boolean;
  readonly project: string;
}

export const runContextHealth = Effect.fn('memory.contextHealth.command')(function* (
  config: RuntimeConfig,
  options: RunContextHealthOptionsV1,
) {
  const project = options.project.trim();
  if (!project) {
    return yield* MemoryOperationError.make({message: 'Provide --project for scoped context health.'});
  }
  const records = yield* readActiveProjectMemoryRecords(config, project);
  const system = yield* SystemInfo;
  const report = yield* collectContextHealth(config, project, records, system.currentDirectory());
  yield* recordHealthValueSnapshot(config.agentContextHome, {
    activeFindings: report.findings.length + report.omittedFindings,
    project,
    timestamp: (yield* DateTime.nowAsDate).toISOString(),
  }).pipe(Effect.ignore);
  yield* writeFinalCliOutput(options.json ? JSON.stringify(report) : renderContextHealth(report));
});

/** Shared read-only evidence collection for health and CI; never prepares a graph. */
export const collectContextHealth = Effect.fn('memory.contextHealth.collect')(function* (
  config: RuntimeConfig,
  project: string,
  records: Parameters<typeof buildContextHealthReport>[0]['records'],
  cwd: string,
  options: {readonly includeFindingUris?: readonly string[]} = {},
) {
  const now = yield* DateTime.nowAsDate;
  const includedUris = options.includeFindingUris === undefined ? undefined : new Set(options.includeFindingUris);
  const evidenceRecords = includedUris === undefined ? records : records.filter(record => includedUris.has(record.uri));
  const citationValidations = yield* validateContextBriefMemoryCitations(
    config,
    {callerCwd: cwd, kind: 'repository', project},
    citationCandidates(evidenceRecords),
  );
  const relationEvidence = yield* relationStatusEvidence(config, evidenceRecords);
  const candidateEvidence = yield* candidateStatusEvidence(config, project);
  const guidanceEvidence = yield* guidanceHealthEvidence(config, project, cwd);
  return buildContextHealthReport({
    candidateEvidence,
    guidanceEvidence,
    citationValidations,
    includeFindingUris: options.includeFindingUris,
    now,
    project,
    records,
    relationEvidence,
  });
});

function citationCandidates(
  records: Parameters<typeof buildContextHealthReport>[0]['records'],
): readonly ContextBriefMemoryCandidateV1[] {
  return records.flatMap((record, rank) => {
    if (record.metadata.kind !== 'durable' && record.metadata.kind !== 'handoff') return [];
    return [
      {
        citationErrorCount: record.metadata.citationErrors?.length ?? 0,
        codeCitations: record.metadata.codeCitations ?? [],
        excerpt: '',
        kind: record.metadata.kind,
        ...(record.metadata.memoryId === undefined ? {} : {memoryId: record.metadata.memoryId}),
        project: record.metadata.project,
        rank,
        uri: record.uri,
      },
    ];
  });
}

const relationStatusEvidence = Effect.fn('memory.contextHealth.relationEvidence')(function* (
  config: RuntimeConfig,
  records: Parameters<typeof buildContextHealthReport>[0]['records'],
) {
  const corpus = yield* readMaintenanceMemoryRecords(config);
  const byUri = new Map(corpus.map(record => [record.uri, record]));
  const identityCandidates = corpus.map(record => ({
    memoryId: record.metadata.memoryId,
    status: record.metadata.status,
    uri: record.uri,
  }));
  const allowedScopes = [`threadnote://user/${uriSegment(config.user)}/memories`];
  return records.flatMap(record =>
    (record.metadata.relations ?? []).map(relation => {
      const memoryId = memoryIdFromIdentityAlias(relation.uri);
      const resolution =
        memoryId === undefined
          ? undefined
          : classifyMemoryIdentityCandidates(identityCandidates, memoryId, allowedScopes);
      const target =
        resolution?.state === 'resolved'
          ? byUri.get(resolution.uri)
          : memoryId === undefined
            ? byUri.get(relation.uri)
            : undefined;
      const inactiveIdentityMatches =
        memoryId === undefined
          ? []
          : corpus.filter(
              candidate => candidate.metadata.memoryId === memoryId && candidate.metadata.status !== 'active',
            );
      return {
        sourceUri: record.uri,
        status:
          resolution?.state === 'ambiguous'
            ? 'conflicted'
            : target?.metadata.status === 'active'
              ? 'active'
              : target !== undefined || inactiveIdentityMatches.length > 0
                ? 'inactive'
                : 'missing',
        targetUri: relation.uri,
      } satisfies ContextHealthRelationEvidenceV1;
    }),
  );
});

const candidateStatusEvidence = Effect.fn('memory.contextHealth.candidateEvidence')(function* (
  config: RuntimeConfig,
  project: string,
) {
  const reviews = yield* listCandidateReviews(config.agentContextHome);
  return reviews
    .filter(review => review.project === project)
    .flatMap(review =>
      review.candidates.flatMap(candidate =>
        candidate.state === 'pending' || candidate.state === 'deferred' || candidate.state === 'applying'
          ? [
              {
                candidateId: candidate.candidateId,
                comparison: candidate.comparison,
                project: candidate.project,
                ...(candidate.targetUri === undefined ? {} : {targetUri: candidate.targetUri}),
              } satisfies ContextHealthCandidateEvidenceV1,
            ]
          : [],
      ),
    );
});

export function renderContextHealth(report: ReturnType<typeof buildContextHealthReport>): string {
  const lines = [
    `Context health for ${report.project}: ${report.recordsScanned} active record${report.recordsScanned === 1 ? '' : 's'}, ${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}.`,
    ...report.findings.map(finding => `- ${finding.severity} ${finding.category}: ${finding.summary}`),
  ];
  if (report.omittedFindings > 0) lines.push(`- ${report.omittedFindings} additional finding(s) omitted by the limit.`);
  return lines.join('\n');
}
