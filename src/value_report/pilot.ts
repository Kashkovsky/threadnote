import {Schema} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {
  isBinaryMetric,
  parsePilotInput,
  PILOT_COUNTS,
  PILOT_DERIVED,
  PILOT_MEASURES,
  PILOT_METRICS,
  PILOT_STRICT,
  PilotReportSchema,
  type PilotEvidence,
  type PilotInput,
  type PilotMetric,
  type PilotMetricSummary,
  type PilotReport,
} from './pilot_contract.js';

type Sample = {
  readonly actor: number;
  readonly state: 'observed' | 'missing' | 'pending' | 'failed' | 'inapplicable';
  readonly value?: number;
};

export function buildPilotReport(raw: unknown): PilotReport {
  const input = parsePilotInput(raw);
  const metrics = {} as Record<PilotMetric, PilotMetricSummary>;
  for (const metric of PILOT_MEASURES) {
    const samples: Sample[] = input.observations.filter(observation => observation.metric === metric);
    const seenActors = new Set(samples.map(sample => sample.actor));
    for (let actor = 0; actor < input.actors; actor += 1) {
      if (!seenActors.has(actor)) samples.push({actor, state: 'missing'});
    }
    metrics[metric] = summarize(metric, samples);
  }
  const derived = deriveEvidence(input);
  for (const metric of PILOT_DERIVED) metrics[metric] = summarize(metric, derived[metric]);
  const weeks = weeklyEvidence(input);
  const retained = weeks.actorSets.reduce(
    (previous, current) => new Set([...previous].filter(actor => current.has(actor))),
  );
  const report = {
    schema: 'threadnote.value-pilot-report.v1' as const,
    version: 1 as const,
    scope: 'single-deployment' as const,
    windowStart: input.windowStart,
    elapsedDays: input.elapsedDays,
    actors: countBucket(input.actors),
    evidenceCoverage: input.evidenceCoverage,
    metrics,
    supportingValue: {
      sources: countBucket(input.sources.length),
      missingSources: countBucket(input.actors - input.sources.length),
      successfulBriefs: countBucket(sum(input.sources.map(source => source.value.report.contextBrief.successful))),
      approvedDeltas: countBucket(sum(input.sources.map(source => source.value.report.knowledgeDelta.approved))),
      setupCompleted: countBucket(sum(input.sources.map(source => source.value.report.setup.completed))),
      healthOpened: countBucket(sum(input.sources.map(source => source.value.report.health.opened))),
      healthResolved: countBucket(sum(input.sources.map(source => source.value.report.health.resolved))),
    },
    weeks: weeks.reports,
    fourWeekCrossActorRetention: {
      state:
        input.elapsedDays < 28
          ? ('pending' as const)
          : retained.size > 0 || input.evidenceCoverage === 'complete'
            ? ('observed' as const)
            : ('missing' as const),
      actors: countBucket(retained.size),
    },
    retention: {
      days: 28 as const,
      correlation: 'memory-only' as const,
      managedExports: 'prune-on-export-or-explicit-retention' as const,
      externalCopies: 'caller-owned' as const,
    },
    evidenceBasis: 'operator-supplied-observations' as const,
    pilotSuccess: 'not-assessed' as const,
  };
  return parsePilotReport({...report, reportDigest: digestReport(report)});
}

export function parsePilotReport(raw: unknown): PilotReport {
  const report = Schema.decodeUnknownSync(PilotReportSchema, PILOT_STRICT)(raw);
  const {reportDigest, ...body} = report;
  if (reportDigest !== digestReport(body)) throw new Error('Invalid pilot report digest.');
  if (
    PILOT_METRICS.some(metric => report.metrics[metric] === undefined) ||
    report.elapsedDays < 1 ||
    report.elapsedDays > 28
  ) {
    throw new Error('Invalid pilot report.');
  }
  if (report.weeks.some((week, index) => week.week !== index + 1)) throw new Error('Invalid pilot report weeks.');
  if (
    report.weeks.some(
      week =>
        week.crossActorFullLoopActors === '0' &&
        (report.evidenceCoverage !== 'complete' || report.elapsedDays < week.week * 7),
    )
  ) {
    throw new Error('Invalid pilot report weeks.');
  }
  return report;
}

export function serializePilotReport(report: PilotReport): string {
  return JSON.stringify(canonical(parsePilotReport(report)), undefined, 2);
}

export function countBucket(count: number): (typeof PILOT_COUNTS)[number] {
  if (count === 0) return '0';
  if (count < 3) return '1-2';
  if (count < 5) return '3-4';
  if (count < 10) return '5-9';
  if (count < 25) return '10-24';
  if (count < 50) return '25-49';
  if (count < 100) return '50-99';
  return '100+';
}

function summarize(metric: PilotMetric, samples: readonly Sample[]): PilotMetricSummary {
  const observed = samples.filter(sample => sample.state === 'observed');
  const positive = observed.filter(sample => sample.value! > 0).length;
  const stateCounts = {observed: observed.length, missing: 0, pending: 0, failed: 0, inapplicable: 0};
  for (const sample of samples) if (sample.state !== 'observed') stateCounts[sample.state] += 1;
  const states = Object.entries(stateCounts)
    .filter(([, count]) => count > 0)
    .map(([state]) => state);
  const state = states.length === 0 ? 'missing' : states.length === 1 ? (states[0] as Sample['state']) : 'mixed';
  const sufficient = new Set(observed.map(sample => sample.actor)).size >= 3;
  const values = observed.map(sample => sample.value!).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
  return {
    state,
    observed: countBucket(stateCounts.observed),
    missing: countBucket(stateCounts.missing),
    pending: countBucket(stateCounts.pending),
    failed: countBucket(stateCounts.failed),
    inapplicable: countBucket(stateCounts.inapplicable),
    positive: countBucket(positive),
    rate:
      !isBinaryMetric(metric) || observed.length === 0
        ? null
        : sufficient
          ? rateBucket(positive, observed.length)
          : 'suppressed',
    median:
      isBinaryMetric(metric) || observed.length === 0 ? null : sufficient ? valueBucket(metric, median) : 'suppressed',
  };
}

function deriveEvidence(input: PilotInput): Record<(typeof PILOT_DERIVED)[number], Sample[]> {
  const firstSourceVerifiedBrief: Sample[] = [];
  const secondActorReuseWithinSevenDays: Sample[] = [];
  const approvedDeltaReuse: Sample[] = [];
  const items = new Map<number, PilotEvidence[]>();
  for (const event of input.evidence) {
    const list = items.get(event.item) ?? [];
    list.push(event);
    items.set(event.item, list);
  }
  for (let actor = 0; actor < input.actors; actor += 1) {
    const found = input.evidence.some(event => event.actor === actor && event.kind === 'verified-brief');
    firstSourceVerifiedBrief.push(outcome(actor, found, input.evidenceCoverage === 'complete'));
  }
  for (const events of items.values()) {
    const origins = events.filter(event => event.kind === 'verified-brief');
    for (const origin of origins) {
      const reuse = events.some(
        event =>
          event.kind === 'verified-reuse' &&
          event.actor !== origin.actor &&
          event.minute > origin.minute &&
          event.minute - origin.minute <= 10_080,
      );
      const mature = input.elapsedDays * 1440 > origin.minute + 10_080;
      secondActorReuseWithinSevenDays.push(
        reuse
          ? {actor: origin.actor, state: 'observed', value: 1}
          : !mature
            ? {actor: origin.actor, state: 'pending'}
            : outcome(origin.actor, false, input.evidenceCoverage === 'complete'),
      );
    }
    const deltas = events.filter(event => event.kind === 'approved-delta');
    for (const delta of deltas) {
      const reuse = events.some(
        event =>
          event.kind === 'verified-reuse' &&
          event.actor !== delta.actor &&
          event.minute > delta.minute &&
          events.some(
            brief => brief.kind === 'verified-brief' && brief.actor === delta.actor && brief.minute <= delta.minute,
          ),
      );
      approvedDeltaReuse.push(outcome(delta.actor, reuse, input.evidenceCoverage === 'complete'));
    }
  }
  return {firstSourceVerifiedBrief, secondActorReuseWithinSevenDays, approvedDeltaReuse};
}

function weeklyEvidence(input: PilotInput): {reports: PilotReport['weeks']; actorSets: Set<number>[]} {
  const reports: PilotReport['weeks'][number][] = [];
  const actorSets: Set<number>[] = [];
  const items = new Map<number, PilotEvidence[]>();
  for (const event of input.evidence) {
    const events = items.get(event.item) ?? [];
    events.push(event);
    items.set(event.item, events);
  }
  for (let week = 1; week <= 4; week += 1) {
    const fullLoop = new Set<number>();
    const crossActor = new Set<number>();
    for (const event of input.evidence) {
      if (event.kind !== 'full-loop' || Math.floor(event.minute / 10_080) !== week - 1) continue;
      const preceding = items
        .get(event.item)!
        .filter(candidate => candidate.item === event.item && candidate.minute < event.minute);
      const approved = preceding.some(
        candidate => candidate.actor === event.actor && candidate.kind === 'approved-delta',
      );
      const verified = preceding.some(
        candidate =>
          candidate.actor === event.actor &&
          (candidate.kind === 'verified-brief' || candidate.kind === 'verified-reuse'),
      );
      if (!approved || !verified) continue;
      fullLoop.add(event.actor);
      const reused = preceding.some(
        candidate =>
          candidate.actor === event.actor &&
          candidate.kind === 'verified-reuse' &&
          preceding.some(
            origin =>
              origin.kind === 'verified-brief' && origin.actor !== candidate.actor && origin.minute < candidate.minute,
          ),
      );
      if (reused) crossActor.add(event.actor);
    }
    const previous = actorSets[actorSets.length - 1];
    reports.push({
      week,
      state:
        input.elapsedDays < week * 7
          ? 'pending'
          : crossActor.size > 0 || input.evidenceCoverage === 'complete'
            ? 'observed'
            : 'missing',
      fullLoopActors: countBucket(fullLoop.size),
      crossActorFullLoopActors:
        crossActor.size > 0 || (input.evidenceCoverage === 'complete' && input.elapsedDays >= week * 7)
          ? countBucket(crossActor.size)
          : null,
      retainedFromPriorWeek:
        previous === undefined || input.elapsedDays < week * 7 || input.evidenceCoverage !== 'complete'
          ? null
          : countBucket([...crossActor].filter(actor => previous.has(actor)).length),
    });
    actorSets.push(crossActor);
  }
  return {reports, actorSets};
}

function outcome(actor: number, positive: boolean, complete: boolean): Sample {
  return positive || complete ? {actor, state: 'observed', value: positive ? 1 : 0} : {actor, state: 'missing'};
}
function rateBucket(positive: number, total: number): NonNullable<PilotMetricSummary['rate']> {
  if (positive === 0) return '0';
  if (positive === total) return '100%';
  const rate = positive / total;
  return rate < 0.25 ? '1-24%' : rate < 0.5 ? '25-49%' : rate < 0.75 ? '50-74%' : '75-99%';
}
function valueBucket(metric: PilotMetric, value: number): NonNullable<PilotMetricSummary['median']> {
  if (value === 0) return 'zero';
  const [low, medium] = metric.endsWith('Milliseconds')
    ? [60_000, 600_000]
    : metric.endsWith('Tokens')
      ? [1_000, 10_000]
      : [3, 10];
  return value <= low ? 'low' : value <= medium ? 'medium' : 'high';
}
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
function digestReport(body: unknown): string {
  return sha256HexSync(JSON.stringify(canonical(body)));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
