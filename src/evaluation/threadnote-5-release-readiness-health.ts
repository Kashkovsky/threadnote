import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {
  buildContextHealthReport,
  type ContextHealthReportInputV1,
  type ContextHealthReportV1,
} from '../memory/context/health.js';
import {
  applyContextHealthRepairProposalV1,
  contextHealthRepairProposalRevisionV1,
  contextHealthReportRevisionV1,
  previewContextHealthRepairPlanV1,
} from '../memory/context/health_repair.js';
import {
  aggregateContextHealthReportsV1,
  buildContextHealthSchedulePlanV1,
  type ContextHealthAggregateSourceV1,
} from '../memory/context/health_schedule.js';
import type {Threadnote5LocalAuthorityEntryV1} from './threadnote-5-release-readiness-authority.js';
import type {Threadnote5MeasurementV1, Threadnote5ReleaseScenario} from './threadnote-5-release-readiness-contract.js';

const MAX_ATTEMPTS = 64;

export interface Threadnote5HealthDerivedClaimsV1 {
  readonly assertions: readonly string[];
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds?: readonly string[];
}

export function deriveThreadnote5HealthClaimsV1(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): Threadnote5HealthDerivedClaimsV1 {
  const source = exactObject(
    value,
    scenario === 'health-maintenance' ? ['aggregate', 'repairs', 'reports', 'schedule'] : ['repairs', 'reports'],
    'context-health artifact',
  );
  const reports = boundedArray(source.reports, 'context-health reports', 0, MAX_ATTEMPTS).map(parseHealthReportCapture);
  const repairs = boundedArray(source.repairs, 'context-health repairs', 0, MAX_ATTEMPTS).map(parseHealthRepairCapture);
  if (!unique(reports.map(contextHealthReportRevisionV1))) throw new Error('Context-health reports must be unique.');
  if (!unique(repairs.map(repair => repair.proposalId))) {
    throw new Error('Context-health repair trials must be unique.');
  }
  if (scenario === 'stale-citation') {
    const categories = new Set(reports.flatMap(report => report.findings.map(finding => finding.category)));
    return {
      assertions: [
        ...(categories.has('citation-changed') ? ['changed-never-current'] : []),
        ...(categories.has('citation-missing') ? ['missing-never-current'] : []),
        ...(categories.has('citation-unknown') ? ['unknown-remains-distinct'] : []),
      ],
      measurements: [],
    };
  }
  if (scenario === 'contradiction-triage') {
    const findings = reports.flatMap(report => report.findings);
    const categories = new Set(findings.map(finding => finding.category));
    return {
      assertions: [
        ...(categories.has('candidate-contradiction') ? ['contradiction-category-observed'] : []),
        ...(categories.has('candidate-possible-duplicate') ? ['possible-duplicate-category-observed'] : []),
        ...(findings.some(finding => finding.repairability === 'manual-review') ? ['manual-review-required'] : []),
        'ordering-stable',
      ],
      measurements: [],
    };
  }
  if (scenario === 'health-maintenance') {
    const schedule = parseHealthScheduleCapture(source.schedule);
    const aggregate = parseHealthAggregateCapture(source.aggregate);
    const resolved = repairs.filter(repair => repair.resolved).length;
    const authorityMissing = authority === undefined;
    if (!authorityMissing && authority?.type !== 'context-health-read-only') {
      throw new Error('Context health authority type does not match its source record.');
    }
    const teamAggregateVerified = authorityMissing
      ? false
      : verifyHealthReadOnlyAuthority(authority, schedule, aggregate);
    return {
      assertions: [
        ...(repairs.length > 0 ? ['health-issue-detected'] : []),
        ...(resolved === repairs.length && repairs.length > 0 ? ['health-resolution-recorded'] : []),
        ...(!authorityMissing ? ['local-scheduled-invocation-read-only'] : []),
        ...(teamAggregateVerified ? ['configured-git-team-aggregation-read-only'] : []),
      ],
      measurements: [{eligibleCount: repairs.length, id: 'health-resolution-rate', positiveCount: resolved}],
      ...(authorityMissing
        ? {missingKinds: ['context-health-schedule-authority', 'context-health-team-aggregate-authority']}
        : teamAggregateVerified
          ? {}
          : {missingKinds: ['context-health-team-selection-evidence']}),
    };
  }
  throw new Error(`Context-health evidence is unsupported for ${scenario}.`);
}

function parseHealthScheduleCapture(value: unknown) {
  const capture = exactObject(value, ['input', 'observedArgv', 'plan'], 'context-health schedule capture');
  const input = exactObject(capture.input, ['cadenceMinutes', 'project', 'teams'], 'context-health schedule input');
  if (!Array.isArray(input.teams) || !input.teams.every(team => typeof team === 'string')) {
    throw new Error('Context-health schedule teams are invalid.');
  }
  const plan = buildContextHealthSchedulePlanV1({
    cadenceMinutes: input.cadenceMinutes as number,
    project: input.project as string,
    teams: input.teams,
  });
  if (canonicalJson(plan) !== canonicalJson(capture.plan)) {
    throw new Error('Context-health schedule plan does not match its source inputs.');
  }
  const observedArgv = boundedArgv(capture.observedArgv, 'context-health observed argv');
  if (canonicalJson(observedArgv) !== canonicalJson(['threadnote', ...plan.argv])) {
    throw new Error('Context-health observed argv does not match its recomputed schedule plan.');
  }
  return plan;
}

function parseHealthAggregateCapture(value: unknown) {
  const capture = exactObject(value, ['aggregate', 'input'], 'context-health aggregate capture');
  const input = exactObject(capture.input, ['personal', 'project', 'teams'], 'context-health aggregate input');
  if (!Array.isArray(input.teams)) throw new Error('Context-health aggregate team sources are invalid.');
  const personal = parseHealthAggregateSource(input.personal, 'personal');
  const teams = input.teams.map(source => parseHealthTeamAggregateSource(source));
  const aggregate = aggregateContextHealthReportsV1({
    personal,
    project: input.project as string,
    teams,
  });
  if (canonicalJson(aggregate) !== canonicalJson(capture.aggregate)) {
    throw new Error('Context-health aggregate does not match its bounded production sources.');
  }
  return {aggregate, input: {...input, teams}};
}

function parseHealthAggregateSource(
  value: unknown,
  scope: 'personal',
): Extract<ContextHealthAggregateSourceV1, {readonly scope: 'personal'}>;
function parseHealthAggregateSource(
  value: unknown,
  scope: 'team',
): Extract<ContextHealthAggregateSourceV1, {readonly scope: 'team'}>;
function parseHealthAggregateSource(
  value: unknown,
  scope: 'team-selection',
): Extract<ContextHealthAggregateSourceV1, {readonly scope: 'team-selection'}>;
function parseHealthAggregateSource(
  value: unknown,
  scope: 'personal' | 'team' | 'team-selection',
): ContextHealthAggregateSourceV1 {
  const source = object(value, 'context-health aggregate source');
  const base = scope === 'team' ? ['scope', 'state', 'team'] : ['scope', 'state'];
  if (source.scope !== scope || (scope === 'team' && typeof source.team !== 'string')) {
    throw new Error('Context-health aggregate source scope is invalid.');
  }
  if (source.state === 'complete') {
    if (scope === 'team-selection') {
      throw new Error('Context-health team selection cannot contain a complete report.');
    }
    exactHealthSourceKeys(source, [...base, 'evidenceRevision', 'report'], 'complete context-health aggregate source');
    if (typeof source.evidenceRevision !== 'string') {
      throw new Error('Context-health source evidence revision is invalid.');
    }
    object(source.report, 'context-health source report');
  } else if (source.state === 'unknown') {
    exactHealthSourceKeys(
      source,
      source.evidenceRevision === undefined ? [...base, 'reason'] : [...base, 'evidenceRevision', 'reason'],
      'unknown context-health aggregate source',
    );
    if (
      ![
        'citation-evidence-unavailable',
        'configured-teams-invalid',
        'evidence-incomplete',
        'snapshot-dirty',
        'snapshot-missing',
        'snapshot-raced',
        'snapshot-unreadable',
        'team-not-configured',
      ].includes(source.reason as string) ||
      (source.evidenceRevision !== undefined && typeof source.evidenceRevision !== 'string')
    ) {
      throw new Error('Context-health unknown source is invalid.');
    }
    if (
      scope === 'team-selection' &&
      source.reason !== 'configured-teams-invalid' &&
      source.reason !== 'snapshot-unreadable'
    ) {
      throw new Error('Context-health team selection reason is invalid.');
    }
  } else {
    throw new Error('Context-health aggregate source state is invalid.');
  }
  return source as unknown as ContextHealthAggregateSourceV1;
}

function parseHealthTeamAggregateSource(
  value: unknown,
):
  | Extract<ContextHealthAggregateSourceV1, {readonly scope: 'team'}>
  | Extract<ContextHealthAggregateSourceV1, {readonly scope: 'team-selection'}> {
  const source = object(value, 'context-health team aggregate source');
  return source.scope === 'team-selection'
    ? parseHealthAggregateSource(source, 'team-selection')
    : parseHealthAggregateSource(source, 'team');
}

function exactHealthSourceKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || !allowedKeys(value, keys)) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function verifyHealthReadOnlyAuthority(
  authority: Extract<Threadnote5LocalAuthorityEntryV1, {readonly type: 'context-health-read-only'}>,
  schedule: ReturnType<typeof parseHealthScheduleCapture>,
  aggregate: ReturnType<typeof parseHealthAggregateCapture>,
): boolean {
  if (
    authority.schedule.networkActivityCount !== 0 ||
    authority.schedule.writeActivityCount !== 0 ||
    authority.aggregate.networkActivityCount !== 0 ||
    authority.aggregate.writeActivityCount !== 0
  ) {
    throw new Error('Context-health authority does not prove read-only, network-disabled execution.');
  }
  if (schedule.project !== aggregate.aggregate.project) {
    throw new Error('Context-health schedule and aggregate projects do not match.');
  }
  const selectedTeams = aggregate.input.teams
    .flatMap(source => (source.scope === 'team' ? [source.team] : []))
    .sort(compareText);
  const selectionUnknown = aggregate.input.teams.some(source => source.scope === 'team-selection');
  if (
    schedule.teams.length > 0 &&
    (selectionUnknown || canonicalJson(schedule.teams) !== canonicalJson(selectedTeams))
  ) {
    throw new Error('Context-health schedule and aggregate team selections do not match.');
  }
  const snapshots = authority.aggregate.teamSnapshots;
  if (
    snapshots.length !== selectedTeams.length ||
    canonicalJson(snapshots.map(snapshot => snapshot.team)) !== canonicalJson(selectedTeams) ||
    snapshots.some(
      snapshot =>
        snapshot.preHead !== snapshot.postHead ||
        snapshot.preIndexDigest !== snapshot.postIndexDigest ||
        snapshot.preWorktreeDigest !== snapshot.postWorktreeDigest,
    )
  ) {
    throw new Error('Context-health authority does not prove stable selected-team snapshots.');
  }
  if (selectionUnknown) return false;
  if (selectedTeams.length === 0) {
    throw new Error('Context-health no-team schedule must retain configured team sources.');
  }
  return true;
}

function boundedArgv(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) throw new Error(`${label} is invalid.`);
  return value.map(item => text(item, label, 512));
}

function parseHealthReportCapture(value: unknown): ContextHealthReportV1 {
  const capture = exactObject(value, ['input', 'report'], 'context-health report capture');
  const input = healthInput(capture.input);
  const rebuilt = buildContextHealthReport(input);
  if (canonicalJson(rebuilt) !== canonicalJson(capture.report)) {
    throw new Error('Context-health report does not match its source inputs.');
  }
  contextHealthReportRevisionV1(rebuilt);
  return rebuilt;
}

function parseHealthRepairCapture(value: unknown): {readonly proposalId: string; readonly resolved: boolean} {
  const capture = exactObject(
    value,
    ['input', 'plan', 'proposal', 'receipt', 'report'],
    'context-health repair capture',
  );
  const input = healthInput(capture.input);
  const report = buildContextHealthReport(input);
  if (canonicalJson(report) !== canonicalJson(capture.report)) {
    throw new Error('Context-health repair report does not match its source inputs.');
  }
  const plan = previewContextHealthRepairPlanV1(report, input.records);
  if (canonicalJson(plan) !== canonicalJson(capture.plan)) throw new Error('Context-health repair plan changed.');
  const proposal = plan.proposals.find(
    item => item.proposalId === object(capture.proposal, 'context-health proposal').proposalId,
  );
  if (proposal === undefined || contextHealthRepairProposalRevisionV1(proposal) !== proposal.revision) {
    throw new Error('Context-health repair proposal is not part of the current plan.');
  }
  if (canonicalJson(proposal) !== canonicalJson(capture.proposal)) {
    throw new Error('Context-health repair proposal differs from the current plan.');
  }
  const applied = applyContextHealthRepairProposalV1({
    expectedRevision: proposal.revision,
    proposal,
    records: input.records,
  });
  if (applied.status !== 'applied' || canonicalJson(applied.receipt) !== canonicalJson(capture.receipt)) {
    throw new Error('Context-health repair receipt cannot be reproduced.');
  }
  const postReport = buildContextHealthReport({...input, records: applied.records});
  return {
    proposalId: proposal.proposalId,
    resolved: !postReport.findings.some(finding => finding.id === proposal.findingId),
  };
}

function healthInput(value: unknown): ContextHealthReportInputV1 {
  const source = object(value, 'context-health input');
  const now = source.now instanceof Date ? source.now : new Date(String(source.now));
  if (!Number.isFinite(now.getTime()) || !Array.isArray(source.records) || typeof source.project !== 'string') {
    throw new Error('Context-health input is invalid.');
  }
  return {...(source as unknown as ContextHealthReportInputV1), now};
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const source = object(value, label);
  if (canonicalJson(Object.keys(source).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
  return source;
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every(key => set.has(key));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} entries.`);
  }
  return value;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} must be bounded non-empty text.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
