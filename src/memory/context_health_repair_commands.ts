import {Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {writeFinalCliOutput} from '../effect/cli_output.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {archiveMemoryForCompact, writeMemoryContentWithExpectedHash} from '../mcp/server/memory.js';
import type {RuntimeConfig} from '../types.js';
import type {CompactableMemoryKind} from './hygiene.js';
import {collectContextHealth} from './context_health_commands.js';
import {
  applyContextHealthRepairProposalV1,
  previewContextHealthRepairPlanV1,
  type ContextHealthRepairApplyReceiptV1,
  type ContextHealthRepairConflictV1,
  type ContextHealthRepairPlanV1,
  type ContextHealthRepairProposalV1,
} from './context_health_repair.js';
import {readActiveProjectMemoryRecords, readMaintenanceMemoryRecords} from './maintenance_records.js';
import {MemoryOperationError} from './migrations.js';
import type {MemoryRecord} from './document.js';

const REPAIR_JOURNAL_VERSION = 1 as const;
const MAXIMUM_REPAIR_JOURNAL_BYTES = 512 * 1_024;
const REPAIR_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 5 * 60 * 1_000,
  waitTimeoutMilliseconds: 5_000,
} as const;
const ARCHIVED_BODY_PREFIX = 'Archived original Threadnote memory.\n\n';

export interface RunContextHealthRepairPreviewOptionsV1 {
  readonly json?: boolean;
  readonly project: string;
}

export interface RunContextHealthRepairApplyOptionsV1 {
  readonly approved?: boolean;
  readonly json?: boolean;
  readonly project: string;
  readonly proposalId: string;
  readonly revision: string;
}

export type ContextHealthRepairApplyCommandResultV1 =
  | {
      readonly conflict: ContextHealthRepairConflictV1;
      readonly proposalId: string;
      readonly revision: string;
      readonly status: 'conflict';
      readonly version: 1;
    }
  | {
      readonly proposalId: string;
      readonly revision: string;
      readonly status: 'review-required';
      readonly version: 1;
    }
  | {
      readonly receipt: ContextHealthRepairApplyReceiptV1;
      readonly proposalId: string;
      readonly revision: string;
      readonly status: 'applied' | 'already-applied';
      readonly version: 1;
    };

interface ContextHealthRepairJournalV1 {
  readonly proposal: ContextHealthRepairProposalV1;
  readonly receipt?: ContextHealthRepairApplyReceiptV1;
  readonly state: 'applied' | 'applying';
  readonly subjectBodyHash?: string;
  readonly subjectMemoryId?: string;
  readonly version: typeof REPAIR_JOURNAL_VERSION;
}

export const previewContextHealthRepairs = Effect.fn('memory.contextHealthRepair.preview')(function* (
  config: RuntimeConfig,
  projectInput: string,
  cwd: string,
) {
  const project = projectInput.trim();
  if (!project) return yield* repairError('Provide --project for scoped context repair.');
  const records = yield* readActiveProjectMemoryRecords(config, project);
  const report = yield* collectContextHealth(config, project, records, cwd);
  return previewContextHealthRepairPlanV1(report, records);
});

export const runContextHealthRepairPreview = Effect.fn('memory.contextHealthRepair.previewCommand')(function* (
  config: RuntimeConfig,
  options: RunContextHealthRepairPreviewOptionsV1,
) {
  const cwd = (yield* SystemInfo).currentDirectory();
  const plan = yield* previewContextHealthRepairs(config, options.project, cwd);
  yield* writeFinalCliOutput(options.json ? JSON.stringify(plan) : renderContextHealthRepairPlan(plan));
});

export const applyContextHealthRepair = Effect.fn('memory.contextHealthRepair.apply')(function* (
  config: RuntimeConfig,
  input: {
    readonly approved?: boolean;
    readonly cwd: string;
    readonly project: string;
    readonly proposalId: string;
    readonly revision: string;
  },
) {
  const project = input.project.trim();
  if (!project) return yield* repairError('Provide --project for scoped context repair.');
  const proposalId = input.proposalId.trim();
  if (!/^health-repair-[0-9a-f]{40}$/u.test(proposalId)) {
    return yield* repairError('Provide a valid proposal ID from context repair preview.');
  }
  const revision = input.revision.trim();
  if (!revision) return yield* repairError('Provide the exact proposal revision from context repair preview.');
  if (input.approved !== true) {
    return yield* repairError('Applying a context-health repair requires --approved after explicit review.');
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const journalPath = repairJournalPath(path, config.agentContextHome, proposalId);
  return yield* withExclusiveFileLock(
    fs,
    `${journalPath}.lock`,
    REPAIR_LOCK_OPTIONS,
    applyLocked(config, {cwd: input.cwd, journalPath, project, proposalId, revision}),
  );
});

export const runContextHealthRepairApply = Effect.fn('memory.contextHealthRepair.applyCommand')(function* (
  config: RuntimeConfig,
  options: RunContextHealthRepairApplyOptionsV1,
) {
  const cwd = (yield* SystemInfo).currentDirectory();
  const result = yield* applyContextHealthRepair(config, {...options, cwd});
  yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderContextHealthRepairApply(result));
});

function applyLocked(
  config: RuntimeConfig,
  input: {
    readonly cwd: string;
    readonly journalPath: string;
    readonly project: string;
    readonly proposalId: string;
    readonly revision: string;
  },
) {
  return Effect.gen(function* () {
    let journal = yield* readRepairJournal(input.journalPath);
    let proposal: ContextHealthRepairProposalV1;
    if (journal) {
      proposal = journal.proposal;
      if (
        proposal.project !== input.project ||
        proposal.proposalId !== input.proposalId ||
        proposal.revision !== input.revision
      ) {
        return yield* repairError('The stored repair journal belongs to another project or proposal revision.');
      }
      if (journal.state === 'applied' && journal.receipt) {
        return publicApplyResult({receipt: journal.receipt, status: 'already-applied'}, proposal);
      }
    } else {
      const plan = yield* previewContextHealthRepairs(config, input.project, input.cwd);
      const matched = plan.proposals.find(item => item.proposalId === input.proposalId);
      if (!matched) {
        return yield* repairError(
          `Repair proposal ${input.proposalId} is no longer present. Preview context repairs again.`,
        );
      }
      proposal = matched;
      const records = yield* readMaintenanceMemoryRecords(config);
      const preflight = applyContextHealthRepairProposalV1({
        expectedRevision: input.revision,
        proposal,
        records,
      });
      if (preflight.status === 'conflict' || preflight.status === 'review-required') {
        return publicApplyResult(preflight, proposal);
      }
      const subject = mutationSubject(proposal, records);
      journal = {
        proposal,
        state: 'applying',
        ...(subject === undefined ? {} : {subjectBodyHash: sha256HexSync(subject.body)}),
        ...(subject?.metadata.memoryId === undefined ? {} : {subjectMemoryId: subject.metadata.memoryId}),
        version: REPAIR_JOURNAL_VERSION,
      };
      yield* writeRepairJournal(input.journalPath, journal);
    }

    const records = yield* readMaintenanceMemoryRecords(config);
    const recovered = recoveredArchiveReceipt(proposal, journal, records);
    if (recovered) {
      yield* writeRepairJournal(input.journalPath, {...journal, receipt: recovered, state: 'applied'});
      return publicApplyResult({receipt: recovered, status: 'already-applied'}, proposal);
    }
    const planned = applyContextHealthRepairProposalV1({
      expectedRevision: input.revision,
      proposal,
      records,
    });
    if (planned.status === 'conflict' || planned.status === 'review-required') {
      return publicApplyResult(planned, proposal);
    }
    if (planned.status === 'already-applied') {
      yield* writeRepairJournal(input.journalPath, {...journal, receipt: planned.receipt, state: 'applied'});
      return publicApplyResult(planned, proposal);
    }

    yield* executeRepairMutation(config, proposal, records, planned.records);
    yield* writeRepairJournal(input.journalPath, {...journal, receipt: planned.receipt, state: 'applied'});
    return publicApplyResult(planned, proposal);
  });
}

function executeRepairMutation(
  config: RuntimeConfig,
  proposal: ContextHealthRepairProposalV1,
  before: readonly MemoryRecord[],
  after: readonly MemoryRecord[],
) {
  return Effect.gen(function* () {
    const mutation = proposal.mutation;
    if (mutation.kind === 'review-only') return yield* repairError('Review-only proposals cannot be applied.');
    const source = before.find(record => record.uri === mutation.subjectUri);
    if (!source) return yield* repairError(`Repair subject ${mutation.subjectUri} is no longer readable.`);
    if (source.uri.includes('/memories/shared/')) {
      return yield* repairError('Context-health repair apply never mutates shared memories.');
    }
    if (mutation.kind === 'archive-memory') {
      const kind = compactableKind(source.metadata.kind);
      if (!kind) return yield* repairError(`Memory kind ${source.metadata.kind} requires manual lifecycle review.`);
      const result = yield* archiveMemoryForCompact(config, {
        expectedContent: source.content,
        kind,
        project: proposal.project,
        reason: proposal.summary,
        sourceUris: proposal.preconditions.map(precondition => precondition.uri),
        topic: source.metadata.topic,
        uri: source.uri,
      });
      if (result.isError === true) return yield* repairError(callResultText(result));
      return;
    }
    const updated = after.find(record => record.uri === mutation.subjectUri);
    if (!updated) return yield* repairError(`Repair did not produce ${mutation.subjectUri}.`);
    const result = yield* writeMemoryContentWithExpectedHash(
      config,
      'threadnote-native',
      source.uri,
      updated.content,
      source.content,
    );
    if (result.isError === true) return yield* repairError(callResultText(result));
  });
}

function recoveredArchiveReceipt(
  proposal: ContextHealthRepairProposalV1,
  journal: ContextHealthRepairJournalV1,
  records: readonly MemoryRecord[],
): ContextHealthRepairApplyReceiptV1 | undefined {
  if (proposal.mutation.kind !== 'archive-memory' || journal.subjectBodyHash === undefined) return undefined;
  if (records.some(record => record.uri === proposal.mutation.subjectUri)) return undefined;
  const matches = records.filter(record => {
    if (
      record.metadata.archivedFrom !== proposal.mutation.subjectUri ||
      record.metadata.project !== proposal.project ||
      !record.body.startsWith(ARCHIVED_BODY_PREFIX)
    ) {
      return false;
    }
    if (journal.subjectMemoryId !== undefined && record.metadata.memoryId !== journal.subjectMemoryId) return false;
    return sha256HexSync(record.body.slice(ARCHIVED_BODY_PREFIX.length)) === journal.subjectBodyHash;
  });
  if (matches.length !== 1) return undefined;
  const subjectPrecondition = proposal.preconditions.find(item => item.uri === proposal.mutation.subjectUri);
  if (!subjectPrecondition) return undefined;
  return {
    proposalId: proposal.proposalId,
    resultHash: subjectPrecondition.expectedContentHash,
    revision: proposal.revision,
    version: 1,
  };
}

function mutationSubject(proposal: ContextHealthRepairProposalV1, records: readonly MemoryRecord[]) {
  return proposal.mutation.kind === 'review-only'
    ? undefined
    : records.find(record => record.uri === proposal.mutation.subjectUri);
}

function publicApplyResult(
  result:
    | {readonly conflict: ContextHealthRepairConflictV1; readonly status: 'conflict'}
    | {readonly status: 'review-required'}
    | {
        readonly receipt: ContextHealthRepairApplyReceiptV1;
        readonly status: 'applied' | 'already-applied';
      },
  proposal: ContextHealthRepairProposalV1,
): ContextHealthRepairApplyCommandResultV1 {
  const proposalId = proposal.proposalId;
  const revision = proposal.revision;
  if (result.status === 'conflict')
    return {conflict: result.conflict, proposalId, revision, status: 'conflict', version: 1};
  if (result.status === 'review-required') return {proposalId, revision, status: 'review-required', version: 1};
  return {proposalId, receipt: result.receipt, revision, status: result.status, version: 1};
}

export function renderContextHealthRepairPlan(plan: ContextHealthRepairPlanV1): string {
  const lines = [
    `Context repair preview for ${plan.project}: ${plan.proposals.length} proposal${plan.proposals.length === 1 ? '' : 's'}.`,
    ...plan.proposals.map(
      proposal =>
        `- ${proposal.proposalId} ${proposal.mutation.kind}: ${proposal.summary}\n  revision: ${proposal.revision}`,
    ),
  ];
  if (plan.omittedProposals > 0) lines.push(`- ${plan.omittedProposals} additional proposal(s) omitted.`);
  return lines.join('\n');
}

export function renderContextHealthRepairApply(result: ContextHealthRepairApplyCommandResultV1): string {
  if (result.status === 'conflict') {
    return `Repair conflict ${result.conflict.conflictId} (${result.conflict.code}): ${result.conflict.message}`;
  }
  if (result.status === 'review-required')
    return `Repair ${result.proposalId} requires manual review; nothing changed.`;
  return `Repair ${result.proposalId} ${result.status === 'applied' ? 'applied' : 'was already applied'} at revision ${result.revision}.`;
}

function repairJournalPath(path: Path.Path, home: string, proposalId: string): string {
  return path.join(home, 'threadnote', 'context-health-repairs', 'v1', `${proposalId}.json`);
}

const readRepairJournal = Effect.fn('memory.contextHealthRepair.readJournal')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) return undefined;
  if (Option.isSome(yield* fs.readLink(path).pipe(Effect.option))) {
    return yield* repairError('Refusing to read a symbolic-link context-health repair journal.');
  }
  const info = yield* fs.stat(path);
  if (info.type !== 'File' || Number(info.size) > MAXIMUM_REPAIR_JOURNAL_BYTES) {
    return yield* repairError('Context-health repair journal is invalid or exceeds its size limit.');
  }
  const raw = yield* fs.readFileString(path);
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw),
    catch: () => MemoryOperationError.make({message: 'Context-health repair journal contains invalid JSON.'}),
  });
  if (!isRepairJournal(parsed)) return yield* repairError('Context-health repair journal has an unsupported shape.');
  return parsed;
});

const writeRepairJournal = Effect.fn('memory.contextHealthRepair.writeJournal')(function* (
  path: string,
  journal: ContextHealthRepairJournalV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const content = `${JSON.stringify(journal, undefined, 2)}\n`;
  if (new TextEncoder().encode(content).byteLength > MAXIMUM_REPAIR_JOURNAL_BYTES) {
    return yield* repairError('Context-health repair journal exceeds its size limit.');
  }
  yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
  const temporaryPath = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
  yield* fs.writeFileString(temporaryPath, content, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, path)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
});

function isRepairJournal(value: unknown): value is ContextHealthRepairJournalV1 {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === REPAIR_JOURNAL_VERSION &&
    (record.state === 'applying' || record.state === 'applied') &&
    typeof record.proposal === 'object' &&
    record.proposal !== null
  );
}

function compactableKind(value: string): CompactableMemoryKind | undefined {
  return value === 'durable' || value === 'handoff' || value === 'incident' ? value : undefined;
}

function repairError(message: string) {
  return MemoryOperationError.make({message});
}

function callResultText(result: {
  readonly content: readonly {readonly text?: string; readonly type: string}[];
}): string {
  return result.content
    .flatMap(item => (item.type === 'text' && item.text !== undefined ? [item.text] : []))
    .join('\n')
    .trim();
}
