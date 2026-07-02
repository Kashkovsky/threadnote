import {basename} from 'node:path';
import {uriSegment} from './manifest.js';
import type {MemoryKind, MemoryStatus} from './types.js';

export type CompactableMemoryKind = Extract<MemoryKind, 'durable' | 'handoff' | 'incident'>;

export interface MemoryMetadata {
  readonly archivedFrom?: string;
  readonly kind: MemoryKind;
  readonly project?: string;
  readonly references?: readonly string[];
  readonly sourceAgentClient: string;
  readonly status: MemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
}

export interface MemoryRecord {
  readonly body: string;
  readonly content: string;
  readonly headerTitle: 'MEMORY' | 'HANDOFF';
  readonly metadata: MemoryMetadata;
  readonly uri: string;
}

export interface CompactPlanOptions {
  readonly kind?: CompactableMemoryKind;
  readonly now?: Date;
  readonly project: string;
  readonly topic?: string;
}

export interface KeepUpdateAction {
  readonly content: string;
  readonly reason: string;
  readonly sourceUris: readonly string[];
  readonly uri: string;
}

export interface ArchiveAction {
  readonly kind: CompactableMemoryKind;
  readonly project: string;
  readonly reason: string;
  readonly topic?: string;
  readonly uri: string;
}

export interface ForgetAction {
  readonly reason: string;
  readonly uri: string;
}

export interface ManualReviewItem {
  readonly reason: string;
  readonly uri: string;
}

export interface CompactPlan {
  readonly archives: readonly ArchiveAction[];
  readonly forgets: readonly ForgetAction[];
  readonly keepUpdates: readonly KeepUpdateAction[];
  readonly manualReview: readonly ManualReviewItem[];
  readonly options: CompactPlanOptions;
  readonly recordsScanned: number;
}

interface GroupedRecord {
  readonly groupKey: string;
  readonly project: string;
  readonly record: MemoryRecord;
  readonly topic?: string;
}

interface ParsedMemoryUri {
  readonly kind: CompactableMemoryKind;
  readonly project: string;
  readonly status: MemoryStatus;
  readonly topic: string;
}

const HYGIENE_SOURCES_HEADING = '## Threadnote Hygiene Sources';
const STALE_HANDOFF_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function parseMemoryDocument(uri: string, content: string): MemoryRecord | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  const separatorIndex = trimmed.indexOf('\n\n');
  const header = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : trimmed.slice(separatorIndex + 2).trim();
  const firstLine = header.split('\n')[0]?.trim();
  if (firstLine !== 'MEMORY' && firstLine !== 'HANDOFF') {
    return undefined;
  }
  const kind =
    parseOptionalMemoryKind(headerValue(header, 'kind')) ?? (firstLine === 'HANDOFF' ? 'handoff' : undefined);
  const status = parseOptionalMemoryStatus(headerValue(header, 'status')) ?? 'active';
  if (!kind) {
    return undefined;
  }
  return {
    body,
    content: trimmed,
    headerTitle: firstLine,
    metadata: {
      archivedFrom: headerValue(header, 'archived_from'),
      kind,
      project: normalizeOptionalMetadata(headerValue(header, 'project') ?? headerValue(header, 'repo')),
      references: headerValues(header, 'references'),
      sourceAgentClient: headerValue(header, 'source_agent_client') ?? 'unknown',
      status,
      supersedes: headerValue(header, 'supersedes'),
      timestamp: headerValue(header, 'timestamp') ?? new Date(0).toISOString(),
      topic: normalizeOptionalMetadata(headerValue(header, 'topic')),
    },
    uri,
  };
}

export function buildCompactPlan(records: readonly MemoryRecord[], options: CompactPlanOptions): CompactPlan {
  const now = options.now ?? new Date();
  const groupedRecords = records
    .map(record => groupableRecord(record))
    .filter((item): item is GroupedRecord => item !== undefined)
    .filter(item => item.project === options.project)
    .filter(item => options.topic === undefined || item.topic === options.topic)
    .filter(item => options.kind === undefined || item.record.metadata.kind === options.kind);

  const groups = new Map<string, GroupedRecord[]>();
  for (const item of groupedRecords) {
    groups.set(item.groupKey, [...(groups.get(item.groupKey) ?? []), item]);
  }

  const keepUpdates: KeepUpdateAction[] = [];
  const archives: ArchiveAction[] = [];
  const forgets: ForgetAction[] = [];
  const manualReview: ManualReviewItem[] = [];

  for (const group of [...groups.values()].sort(compareGroupedRecordLists)) {
    const recordsInGroup = group.map(item => item.record);
    const kind = recordsInGroup[0]?.metadata.kind;
    const topic = group[0]?.topic;
    const project = group[0]?.project;
    if (!kind || !project || !isCompactableKind(kind)) {
      continue;
    }

    const duplicateGroups = groupBy(recordsInGroup, record => comparableMemoryBody(record.body));
    const duplicateForgetUris = new Set<string>();
    const distinctBodyCount = duplicateGroups.size;
    for (const duplicateGroup of duplicateGroups.values()) {
      if (duplicateGroup.length < 2) {
        continue;
      }
      const duplicateKeep = preferredKeepRecord(duplicateGroup, topic);
      for (const duplicate of sortedNewestFirst(duplicateGroup).filter(record => record.uri !== duplicateKeep.uri)) {
        duplicateForgetUris.add(duplicate.uri);
        forgets.push({reason: `exact duplicate of ${duplicateKeep.uri}`, uri: duplicate.uri});
      }
      if (distinctBodyCount === 1 || kind !== 'handoff') {
        keepUpdates.push({
          content: memoryContentWithHygieneSources(
            duplicateKeep,
            duplicateGroup.map(record => record.uri),
          ),
          reason: 'keep exact duplicate group with source URIs',
          sourceUris: duplicateGroup.map(record => record.uri),
          uri: duplicateKeep.uri,
        });
      }
    }

    const remainingRecords = recordsInGroup.filter(record => !duplicateForgetUris.has(record.uri));
    if (recordsInGroup.length > 1 && distinctBodyCount === 1) {
      continue;
    }
    if (remainingRecords.length === 0) {
      continue;
    }
    if (remainingRecords.length === 1) {
      const [record] = remainingRecords;
      if (!record) {
        continue;
      }
      if (record.metadata.supersedes === record.uri) {
        keepUpdates.push({
          content: memoryContentWithHygieneSources(record, [record.uri]),
          reason: 'strip self-supersedes header',
          sourceUris: [record.uri],
          uri: record.uri,
        });
      }
      if (isStaleLookingHandoff(record, now)) {
        manualReview.push({reason: 'stale-looking active handoff', uri: record.uri});
      }
      continue;
    }

    if (kind === 'handoff') {
      const keep = preferredKeepRecord(remainingRecords, topic);
      const sourceUris = recordsInGroup.map(record => record.uri);
      keepUpdates.push({
        content: memoryContentWithHygieneSources(keep, sourceUris),
        reason: 'keep latest handoff and preserve source URIs',
        sourceUris,
        uri: keep.uri,
      });
      for (const record of sortedNewestFirst(remainingRecords).filter(item => item.uri !== keep.uri)) {
        archives.push({
          kind,
          project,
          reason: `older handoff for ${project}/${topic ?? 'unknown'}`,
          topic,
          uri: record.uri,
        });
      }
      continue;
    }

    for (const record of sortedNewestFirst(remainingRecords)) {
      manualReview.push({reason: `non-exact ${kind} memory in overlapping group`, uri: record.uri});
    }
  }

  return {
    archives: dedupeByUri(archives),
    forgets: dedupeByUri(forgets),
    keepUpdates: dedupeByUri(keepUpdates),
    manualReview: dedupeByUri(manualReview),
    options,
    recordsScanned: groupedRecords.length,
  };
}

export function memoryContentWithHygieneSources(record: MemoryRecord, sourceUris: readonly string[]): string {
  const body = stripHygieneSources(record.body);
  const uniqueSourceUris = [...new Set(sourceUris)].sort();
  const metadata = {
    ...record.metadata,
    supersedes: record.metadata.supersedes === record.uri ? undefined : record.metadata.supersedes,
  };
  return formatMemoryDocument(
    record.headerTitle,
    metadata,
    [body, '', HYGIENE_SOURCES_HEADING, '', ...uniqueSourceUris.map(uri => `- ${uri}`)].join('\n'),
  );
}

export function formatCompactPlan(plan: CompactPlan, options: {readonly apply: boolean}): string {
  const scope = [
    `project ${plan.options.project}`,
    plan.options.topic ? `topic ${plan.options.topic}` : undefined,
    plan.options.kind ? `kind ${plan.options.kind}` : undefined,
  ]
    .filter((item): item is string => item !== undefined)
    .join(', ');
  const lines = [
    `${options.apply ? 'Applying' : 'Dry-run'} memory hygiene plan for ${scope}`,
    `Records scanned: ${plan.recordsScanned}`,
    '',
    formatPlanSection(
      'Keep/update',
      plan.keepUpdates.map(action => `${action.uri} (${action.reason}; sources: ${action.sourceUris.length})`),
    ),
    formatPlanSection(
      'Archive old handoffs',
      plan.archives.map(action => `${action.uri} (${action.reason})`),
    ),
    formatPlanSection(
      'Forget exact duplicates',
      plan.forgets.map(action => `${action.uri} (${action.reason})`),
    ),
    formatPlanSection(
      'Manual review',
      plan.manualReview.map(item => `${item.uri} (${item.reason})`),
    ),
  ];
  if (!options.apply) {
    lines.push('', 'No changes made. Re-run with --apply to execute this plan.');
  }
  return lines.join('\n');
}

export function recallHygieneNudges(
  text: string,
  options: {readonly records?: readonly MemoryRecord[]; readonly user: string},
): readonly string[] {
  const activeUris = activePersonalMemoryUrisFromText(text, options.user);
  const nudges: string[] = [];
  const returnedUriSet = new Set(activeUris);
  const returnedRecords =
    options.records?.filter(record => returnedUriSet.has(record.uri)).map(record => groupableRecord(record)) ?? [];
  const groups = new Map<string, GroupedRecord[]>();
  for (const item of returnedRecords) {
    if (!item) {
      continue;
    }
    groups.set(item.groupKey, [...(groups.get(item.groupKey) ?? []), item]);
  }
  for (const group of [...groups.values()].sort(compareGroupedRecordLists)) {
    if (group.length < 3) {
      continue;
    }
    const first = group[0];
    if (!first || !isCompactableKind(first.record.metadata.kind)) {
      continue;
    }
    const topic = first.topic;
    if (!topic) {
      continue;
    }
    nudges.push(
      `${group.length} active ${memoryKindPlural(first.record.metadata.kind)} look overlapping for ${first.project}/${topic}; run compact_context({"project":"${first.project}","topic":"${topic}","dryRun":true}).`,
    );
  }

  const projectCounts = new Map<string, number>();
  for (const uri of activeUris) {
    const parsed = parsePersonalMemoryUri(uri, options.user);
    if (!parsed || parsed.kind !== 'handoff' || parsed.status !== 'active') {
      continue;
    }
    projectCounts.set(parsed.project, (projectCounts.get(parsed.project) ?? 0) + 1);
  }
  for (const [project, count] of [...projectCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (count < 10) {
      continue;
    }
    nudges.push(
      `Many active handoffs surfaced for ${project}; run compact_context({"project":"${project}","dryRun":true}).`,
    );
  }
  return [...new Set(nudges)];
}

/**
 * Collects one-way `references:` pointers off already-surfaced memory records,
 * dropping any URI that recall already displayed so the referenced-context pass
 * only adds prior context the caller has not already seen. Deduped, order
 * preserved.
 */
export function referencedUrisFromRecords(records: readonly MemoryRecord[], recallOutput: string): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const record of records) {
    for (const uri of record.metadata.references ?? []) {
      if (seen.has(uri) || recallOutput.includes(uri)) {
        continue;
      }
      seen.add(uri);
      result.push(uri);
    }
  }
  return result;
}

/** Renders a short, indented excerpt of a referenced memory body for recall. */
export function referencedContextExcerpt(body: string, maxLines: number): string {
  const lines = body
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(0, maxLines);
  return lines.map(line => `  ${line}`).join('\n');
}

export function activePersonalMemoryUrisFromText(text: string, user: string): readonly string[] {
  const userSegment = uriSegment(user);
  const matches = text.matchAll(/viking:\/\/[^\s)]+/g);
  const uris: string[] = [];
  for (const match of matches) {
    const uri = match[0]?.replace(/[.,;:]+$/g, '');
    if (!uri || !parsePersonalMemoryUri(uri, userSegment)) {
      continue;
    }
    uris.push(uri);
  }
  return [...new Set(uris)];
}

export function parsePersonalMemoryUri(uri: string, user: string): ParsedMemoryUri | undefined {
  const prefix = `viking://user/${uriSegment(user)}/memories/`;
  if (!uri.startsWith(prefix) || uri.includes('/shared/')) {
    return undefined;
  }
  const rest = uri.slice(prefix.length);
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 4) {
    return undefined;
  }
  if (parts[0] === 'handoffs' && parts[1] === 'active' && parts[2] && parts[3]?.endsWith('.md')) {
    return {kind: 'handoff', project: parts[2], status: 'active', topic: parts[3].replace(/\.md$/, '')};
  }
  if (parts[0] === 'durable' && parts[1] === 'projects' && parts[2] && parts[3]?.endsWith('.md')) {
    return {kind: 'durable', project: parts[2], status: 'active', topic: parts[3].replace(/\.md$/, '')};
  }
  if (parts[0] === 'incidents' && parts[1] === 'active' && parts[2] && parts[3]?.endsWith('.md')) {
    return {kind: 'incident', project: parts[2], status: 'active', topic: parts[3].replace(/\.md$/, '')};
  }
  return undefined;
}

export function handoffTopicForBranch(
  branch: string | undefined,
  options: {readonly timestamped?: boolean; readonly topic?: string},
): string | undefined {
  const topic = normalizeOptionalMetadata(options.topic);
  if (options.timestamped === true) {
    if (topic) {
      throw new Error('Cannot combine --timestamped with --topic.');
    }
    return undefined;
  }
  return topic ?? normalizeOptionalMetadata(branch) ?? 'current';
}

function groupableRecord(record: MemoryRecord): GroupedRecord | undefined {
  if (record.metadata.status !== 'active' || !isCompactableKind(record.metadata.kind)) {
    return undefined;
  }
  const project = normalizeOptionalMetadata(record.metadata.project) ?? parseProjectFromUri(record.uri);
  if (!project) {
    return undefined;
  }
  const topic = topicForRecord(record);
  const groupKey = [record.metadata.kind, project, topic ?? record.uri].join('\0');
  return {groupKey, project, record, topic};
}

export function topicForRecord(record: MemoryRecord): string | undefined {
  return (
    normalizeOptionalMetadata(record.metadata.topic) ??
    normalizeOptionalMetadata(branchFromBody(record.body)) ??
    topicFromUri(record.uri)
  );
}

function branchFromBody(body: string): string | undefined {
  const branch = /^branch:\s*(.+)$/m.exec(body)?.[1]?.trim();
  return branch?.split(/\s+/)[0]?.replace(/[.,;:]+$/g, '');
}

function topicFromUri(uri: string): string | undefined {
  const name = basename(uri).replace(/\.md$/, '');
  return name.startsWith('threadnote-') ? undefined : name;
}

function parseProjectFromUri(uri: string): string | undefined {
  const parts = uri.split('/memories/')[1]?.split('/').filter(Boolean) ?? [];
  if ((parts[0] === 'handoffs' || parts[0] === 'incidents') && parts[1] === 'active') {
    return parts[2];
  }
  if (parts[0] === 'durable' && parts[1] === 'projects') {
    return parts[2];
  }
  return undefined;
}

function comparableMemoryBody(body: string): string {
  return stripHygieneSources(body).trim().replace(/\s+/g, ' ');
}

function stripHygieneSources(body: string): string {
  const index = body.indexOf(`\n${HYGIENE_SOURCES_HEADING}`);
  if (index !== -1) {
    return body.slice(0, index).trim();
  }
  return body.startsWith(HYGIENE_SOURCES_HEADING) ? '' : body.trim();
}

function preferredKeepRecord(records: readonly MemoryRecord[], topic?: string): MemoryRecord {
  const stableRecords = records.filter(record => isStableRecord(record, topic));
  return sortedNewestFirst(stableRecords.length > 0 ? stableRecords : records)[0] ?? records[0]!;
}

function isStableRecord(record: MemoryRecord, topic?: string): boolean {
  const recordTopic = topic ?? topicForRecord(record);
  return recordTopic !== undefined && basename(record.uri) === `${uriSegment(recordTopic)}.md`;
}

function sortedNewestFirst<T extends MemoryRecord>(records: readonly T[]): readonly T[] {
  return [...records].sort((left, right) => {
    const timestampDiff = timestampMs(right) - timestampMs(left);
    return timestampDiff === 0 ? left.uri.localeCompare(right.uri) : timestampDiff;
  });
}

function timestampMs(record: MemoryRecord): number {
  const parsed = Date.parse(record.metadata.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isStaleLookingHandoff(record: MemoryRecord, now: Date): boolean {
  if (record.metadata.kind !== 'handoff') {
    return false;
  }
  if (now.getTime() - timestampMs(record) < STALE_HANDOFF_AGE_MS) {
    return false;
  }
  return /\b(?:PR|pull request)\s+(?:OPEN|open|is open)|awaiting review|waiting for review|next steps?:\s*address PR review/i.test(
    record.body,
  );
}

function groupBy<T>(values: readonly T[], keyForValue: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyForValue(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function compareGroupedRecordLists(left: readonly GroupedRecord[], right: readonly GroupedRecord[]): number {
  return (left[0]?.groupKey ?? '').localeCompare(right[0]?.groupKey ?? '');
}

function dedupeByUri<T extends {readonly uri: string}>(items: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.uri)) {
      continue;
    }
    seen.add(item.uri);
    result.push(item);
  }
  return result;
}

function formatMemoryDocument(title: 'MEMORY' | 'HANDOFF', metadata: MemoryMetadata, body: string): string {
  const header = [
    title,
    `kind: ${metadata.kind}`,
    `status: ${metadata.status}`,
    metadata.project ? `project: ${metadata.project}` : undefined,
    metadata.topic ? `topic: ${metadata.topic}` : undefined,
    `source_agent_client: ${metadata.sourceAgentClient}`,
    `timestamp: ${metadata.timestamp}`,
    metadata.supersedes ? `supersedes: ${metadata.supersedes}` : undefined,
    metadata.archivedFrom ? `archived_from: ${metadata.archivedFrom}` : undefined,
    ...(metadata.references ?? []).map(uri => `references: ${uri}`),
  ].filter((line): line is string => line !== undefined);
  return [...header, '', body.trim()].join('\n');
}

function headerValue(header: string, key: string): string | undefined {
  const prefix = `${key}:`;
  return header
    .split('\n')
    .find(line => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function headerValues(header: string, key: string): readonly string[] | undefined {
  const prefix = `${key}:`;
  const values = header
    .split('\n')
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length).trim())
    .filter(value => value.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseOptionalMemoryKind(value: string | undefined): MemoryKind | undefined {
  if (!value) {
    return undefined;
  }
  if (['durable', 'handoff', 'incident', 'preference', 'smoke'].includes(value)) {
    return value as MemoryKind;
  }
  return undefined;
}

function parseOptionalMemoryStatus(value: string | undefined): MemoryStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (['active', 'archived', 'superseded'].includes(value)) {
    return value as MemoryStatus;
  }
  return undefined;
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isCompactableKind(kind: MemoryKind): kind is CompactableMemoryKind {
  return kind === 'durable' || kind === 'handoff' || kind === 'incident';
}

function memoryKindPlural(kind: MemoryKind): string {
  switch (kind) {
    case 'handoff':
      return 'handoffs';
    case 'incident':
      return 'incidents';
    case 'durable':
      return 'durable memories';
    case 'preference':
      return 'preferences';
    case 'smoke':
      return 'smoke memories';
  }
}

function formatPlanSection(title: string, lines: readonly string[]): string {
  if (lines.length === 0) {
    return `${title}:\n- none`;
  }
  return [`${title}:`, ...lines.map(line => `- ${line}`)].join('\n');
}
