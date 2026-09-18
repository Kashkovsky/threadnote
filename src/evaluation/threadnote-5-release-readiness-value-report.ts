import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {activationReceiptRevisionV1, parseActivationPlanV1, parseActivationReceiptV1} from '../activation/contract.js';
import {activationValueEventsV1} from '../activation/value.js';
import {RECALL_FEEDBACK_ACTIONS, type RecallFeedbackEvent} from '../recall/feedback.js';
import {summarizeLocalValueEvents, type LocalValueEventV1} from '../value_report/events.js';
import {aggregateValueReportV1, type ValueReportInputV1, type ValueReportV1} from '../value_report/index.js';
import {
  threadnote5RecallFeedbackEventDigest,
  threadnote5ValueReportOfflineObservationDigest,
  type Threadnote5LocalAuthorityEntryV1,
} from './threadnote-5-release-readiness-authority.js';
import {
  type Threadnote5MeasurementV1,
  type Threadnote5ReleaseScenario,
} from './threadnote-5-release-readiness-contract.js';
import {
  allowedKeys,
  boundedArray,
  compareText,
  exactObject,
  hash,
  hashText,
  integerIn,
  isoInstant,
  nonEmptyText,
  object,
  text,
  unique,
} from './threadnote-5-release-readiness-validation.js';

const MAX_ATTEMPTS = 64;

export interface Threadnote5ActivationValueLinkV1 {
  readonly activationId: string;
  readonly finalReceiptRevision: string;
}

export interface Threadnote5FeedbackTrialLinkV1 {
  readonly action: RecallFeedbackEvent['action'];
  readonly feedbackEventDigest: string;
  readonly laneId: string;
  readonly offlineObservationDigest: string | null;
  readonly offlineVerified: boolean;
}

export interface Threadnote5ValueReportDerivedClaimsV1 {
  readonly assertions: readonly string[];
  readonly correlations?: {
    readonly activationValues?: readonly Threadnote5ActivationValueLinkV1[];
    readonly feedbackTrials: readonly Threadnote5FeedbackTrialLinkV1[];
  };
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds?: readonly string[];
}

export function deriveThreadnote5ValueReportClaims(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): Threadnote5ValueReportDerivedClaimsV1 {
  const source = object(value, 'value-report artifact');
  if (!allowedKeys(source, ['activationTrials', 'captures', 'feedbackTrials']) || !Array.isArray(source.captures)) {
    throw new Error('Value-report artifact has unsupported fields.');
  }
  const captures = boundedArray(source.captures, 'value-report captures', 1, MAX_ATTEMPTS).map(parseValueReportCapture);
  if (!unique(captures.map(capture => `${capture.report.period.from}\0${capture.report.period.to}`))) {
    throw new Error('Value-report capture periods must be unique.');
  }
  const feedbackTrials = boundedArray(source.feedbackTrials, 'value-report feedback trials', 1, MAX_ATTEMPTS).map(
    item => parseFeedbackTrial(item, scenario),
  );
  if (
    !unique(feedbackTrials.map(trial => trial.feedbackEventDigest)) ||
    !unique(feedbackTrials.map(trial => trial.laneId))
  ) {
    throw new Error('Value-report feedback trials must be unique.');
  }
  const capturedEvents = captures.flatMap(capture => capture.feedbackEvents);
  if (
    canonicalJson(capturedEvents.map(threadnote5RecallFeedbackEventDigest).sort(compareText)) !==
    canonicalJson(feedbackTrials.map(trial => trial.feedbackEventDigest).sort(compareText))
  ) {
    throw new Error('Value-report feedback trials do not exactly cover the raw report events.');
  }
  const reports = captures.map(capture => capture.report);
  const eligibleWrong = feedbackTrials.length;
  const wrong = feedbackTrials.filter(trial => trial.action === 'wrong').length;
  assertFeedbackTrialsMatchReports(feedbackTrials, reports);
  const eligibleReuse = reports.reduce((sum, report) => sum + report.setup.started, 0);
  const reuse = reports.reduce((sum, report) => sum + report.setup.supportedAgentReuse, 0);
  if (reports.some(report => report.setup.supportedAgentReuse > report.setup.started)) {
    throw new Error('Value report reuse cannot exceed setup attempts.');
  }
  const activationLinks =
    source.activationTrials === undefined
      ? undefined
      : activationValueTrials(boundedArray(source.activationTrials, 'activation value trials', 1, MAX_ATTEMPTS));
  const measurements = valueReportMeasurements(scenario, eligibleWrong, wrong, eligibleReuse, reuse);
  if (authority === undefined) {
    return {assertions: [], measurements, missingKinds: ['value-report-trial-authority']};
  }
  if (authority.type !== 'value-report-verification') {
    throw new Error('Value Report authority type does not match its source record.');
  }
  const expectedAuthority = feedbackTrials.map(trial => ({
    feedbackEventDigest: trial.feedbackEventDigest,
    laneId: trial.laneId,
    offlineObservationDigest: trial.offlineObservationDigest,
  }));
  if (
    canonicalJson(authority.trials) !==
    canonicalJson(
      [...expectedAuthority].sort((left, right) => compareText(left.feedbackEventDigest, right.feedbackEventDigest)),
    )
  ) {
    throw new Error('Value Report authority does not match its raw feedback trials.');
  }
  return {
    assertions: [],
    correlations: {
      ...(activationLinks === undefined ? {} : {activationValues: activationLinks}),
      feedbackTrials,
    },
    measurements,
    ...(scenario === 'two-agent' && activationLinks === undefined
      ? {missingKinds: ['activation', 'activation-value-linkage']}
      : {}),
  };
}

function assertFeedbackTrialsMatchReports(
  feedbackTrials: readonly Threadnote5FeedbackTrialLinkV1[],
  reports: readonly ValueReportV1[],
): void {
  const expected = {
    applied: feedbackTrials.filter(trial => trial.action === 'applied').length,
    dismiss: feedbackTrials.filter(trial => trial.action === 'dismiss').length,
    pin: feedbackTrials.filter(trial => trial.action === 'pin').length,
    total: feedbackTrials.length,
    useful: feedbackTrials.filter(trial => trial.action === 'useful').length,
    wrong: feedbackTrials.filter(trial => trial.action === 'wrong').length,
  };
  const actual = reports.reduce(
    (counts, report) => ({
      applied: counts.applied + report.feedback.applied,
      dismiss: counts.dismiss + report.feedback.dismiss,
      pin: counts.pin + report.feedback.pin,
      total: counts.total + report.feedback.total,
      useful: counts.useful + report.feedback.useful,
      wrong: counts.wrong + report.feedback.wrong,
    }),
    {applied: 0, dismiss: 0, pin: 0, total: 0, useful: 0, wrong: 0},
  );
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('Value-report feedback trials are filtered by report period or project scope.');
  }
}

function valueReportMeasurements(
  scenario: Threadnote5ReleaseScenario,
  eligibleWrong: number,
  wrong: number,
  eligibleReuse: number,
  reuse: number,
): readonly Threadnote5MeasurementV1[] {
  return [
    {eligibleCount: eligibleWrong, id: 'wrong-memory-rate', positiveCount: wrong},
    ...(scenario === 'two-agent'
      ? [{eligibleCount: eligibleReuse, id: 'second-agent-reuse-rate' as const, positiveCount: reuse}]
      : []),
  ];
}

function parseFeedbackTrial(value: unknown, scenario: Threadnote5ReleaseScenario): Threadnote5FeedbackTrialLinkV1 {
  const trial = exactObject(value, ['event', 'laneId', 'offlineObservation'], 'value-report feedback trial');
  const event = parseRecallFeedbackEvent(trial.event);
  const offlineObservation =
    trial.offlineObservation === null
      ? null
      : exactObject(
          trial.offlineObservation,
          ['afterAttemptCount', 'beforeAttemptCount'],
          'Value Report offline observation',
        );
  if (
    (scenario === 'offline') !== (offlineObservation !== null) ||
    (offlineObservation !== null &&
      (offlineObservation.beforeAttemptCount !== 0 || offlineObservation.afterAttemptCount !== 0))
  ) {
    throw new Error('Value Report offline trial requires an independently observed zero-network boundary.');
  }
  return {
    action: event.action,
    feedbackEventDigest: threadnote5RecallFeedbackEventDigest(event),
    laneId: hashText(trial.laneId, 'Value Report lane ID'),
    offlineObservationDigest:
      offlineObservation === null ? null : threadnote5ValueReportOfflineObservationDigest(offlineObservation),
    offlineVerified: offlineObservation !== null,
  };
}

function activationValueTrials(trials: readonly unknown[]): readonly Threadnote5ActivationValueLinkV1[] {
  const links: Threadnote5ActivationValueLinkV1[] = [];
  for (const value of trials) {
    const trial = exactObject(value, ['events', 'input', 'report', 'state'], 'activation value trial');
    const state = exactObject(trial.state, ['plan', 'receipt'], 'activation value state');
    const plan = parseActivationPlanV1(state.plan);
    const receipt = parseActivationReceiptV1(state.receipt);
    if (
      receipt.activationId !== plan.activationId ||
      receipt.planHash !== plan.planHash ||
      activationReceiptRevisionV1(receipt) !== receipt.revision
    ) {
      throw new Error('Activation value trial state does not match its plan.');
    }
    if (!Array.isArray(trial.events)) throw new Error('Activation value trial events are invalid.');
    const events = trial.events.map(parseLocalValueEvent);
    const expected = activationValueEventsV1(receipt);
    if (
      events.length !== expected.length ||
      !unique(events.map(event => event.eventId)) ||
      !unique(expected.map(event => event.eventId))
    ) {
      throw new Error('Activation value trial events are incomplete or duplicated.');
    }
    for (const event of expected) {
      const actual = events.find(candidate => candidate.kind === 'activation' && candidate.eventId === event.eventId);
      if (canonicalJson(actual) !== canonicalJson(event)) {
        throw new Error('Activation value trial event does not match the production projection.');
      }
    }
    const input = object(trial.input, 'activation value report input');
    const report = aggregateValueReportV1({
      ...(input as unknown as ValueReportInputV1),
      counts: summarizeLocalValueEvents(events, {
        from: new Date(text(object(input.period, 'activation value period').from, 'activation value period from', 64)),
        to: new Date(text(object(input.period, 'activation value period').to, 'activation value period to', 64)),
      }),
    });
    if (canonicalJson(report) !== canonicalJson(trial.report)) {
      throw new Error('Activation value trial report does not match its raw events.');
    }
    links.push({activationId: plan.activationId, finalReceiptRevision: receipt.revision});
  }
  if (!unique(links.map(link => link.activationId))) throw new Error('Activation value trials must be unique.');
  return links;
}

function parseLocalValueEvent(value: unknown): Extract<LocalValueEventV1, {readonly kind: 'activation'}> {
  const event = object(value, 'local value event');
  if (
    event.kind !== 'activation' ||
    event.version !== 1 ||
    !hash(event.eventId) ||
    !integerIn(event.durationMilliseconds, 0, 7 * 24 * 60 * 60 * 1_000) ||
    !isoInstant(event.timestamp) ||
    !['started', 'first-evidence', 'completed', 'second-surface-proof'].includes(event.phase as string) ||
    !allowedKeys(event, ['durationMilliseconds', 'eventId', 'kind', 'phase', 'timestamp', 'version'])
  ) {
    throw new Error('Activation value event is invalid.');
  }
  return event as unknown as Extract<LocalValueEventV1, {readonly kind: 'activation'}>;
}

function parseValueReportCapture(value: unknown): {
  readonly feedbackEvents: readonly RecallFeedbackEvent[];
  readonly report: ValueReportV1;
} {
  const capture = exactObject(value, ['input', 'report'], 'value-report capture');
  const input = object(capture.input, 'value-report input');
  const feedbackEvents = Array.isArray(input.feedbackEvents) ? input.feedbackEvents.map(parseRecallFeedbackEvent) : [];
  const rebuilt = aggregateValueReportV1({...input, feedbackEvents} as unknown as ValueReportInputV1);
  if (canonicalJson(rebuilt) !== canonicalJson(capture.report)) {
    throw new Error('Value report does not match its source events and counts.');
  }
  return {feedbackEvents, report: rebuilt};
}

function parseRecallFeedbackEvent(value: unknown): RecallFeedbackEvent {
  const event = object(value, 'recall feedback event');
  const keys =
    event.project === undefined
      ? ['action', 'queryFingerprint', 'rankerVersion', 'timestamp', 'uri', 'version']
      : ['action', 'project', 'queryFingerprint', 'rankerVersion', 'timestamp', 'uri', 'version'];
  if (
    canonicalJson(Object.keys(event).sort()) !== canonicalJson(keys.sort()) ||
    event.version !== 1 ||
    !RECALL_FEEDBACK_ACTIONS.includes(event.action as RecallFeedbackEvent['action']) ||
    !hash(event.queryFingerprint) ||
    !nonEmptyText(event.rankerVersion, 128) ||
    !isoInstant(event.timestamp) ||
    !nonEmptyText(event.uri, 2_048) ||
    (event.project !== undefined && !nonEmptyText(event.project, 256))
  ) {
    throw new Error('Recall feedback event is invalid.');
  }
  return event as unknown as RecallFeedbackEvent;
}
