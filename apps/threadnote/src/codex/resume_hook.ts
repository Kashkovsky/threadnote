import {Clock, Console, Crypto, DateTime, Effect, FileSystem, Option, Path, Result} from 'effect';
import {compileContextBrief} from '../context_brief/index.js';
import {CODEX_RESUME_ADDITIONAL_CONTEXT_LIMIT} from './hooks.js';
import {THREADNOTE_CODEX_RESUME_PRELOAD_ENV} from '../constants.js';
import {readHookPayload} from '../hooks.js';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {worktreeBuildRequestState} from '@threadnote/graph/inventory';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {isJsonObject} from '../utils.js';
import {recordCodexResumePreloadValueEvent, type CodexResumePreloadOutcome} from '../value_report/events.js';
import type {ContextBriefEvidenceState, ProjectedContextBriefV1} from '@threadnote/context/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const CODEX_RESUME_HOOK_TIMEOUT = '10 seconds';
const CODEX_RESUME_RECEIPT_VERSION = 1 as const;
const CODEX_RESUME_RECEIPT_MAXIMUM_BYTES = 1_024;
const CODEX_RESUME_IDENTIFIER_MAXIMUM_BYTES = 512;
const CODEX_RESUME_PATH_MAXIMUM_BYTES = 4_096;
const UTF8 = new TextEncoder();
const RECEIPT_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 1_000,
} as const;

export interface CodexResumeHookEvent {
  readonly cwd: string;
  readonly hookEventName: 'UserPromptSubmit';
  readonly prompt: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface CodexResumeReceiptV1 {
  readonly evidenceGeneration: string;
  readonly evidenceHash: string;
  readonly version: typeof CODEX_RESUME_RECEIPT_VERSION;
}

export type CodexResumeHookResult =
  | {
      readonly context: string;
      readonly estimatedTokens: number;
      readonly evidenceState: 'sufficient';
      readonly outputBytes: number;
      readonly outcome: 'injected';
    }
  | {
      readonly estimatedTokens: number;
      readonly evidenceState?: ContextBriefEvidenceState;
      readonly outputBytes: number;
      readonly outcome: Exclude<CodexResumePreloadOutcome, 'injected'>;
    };

export interface CodexResumeDecisionDependencies<Requirements = never> {
  readonly compile: (cwd: string, prompt: string) => Effect.Effect<ProjectedContextBriefV1, unknown, Requirements>;
  readonly deliver: (context: string) => Effect.Effect<void, unknown, Requirements>;
  readonly receipt: Effect.Effect<CodexResumeReceiptV1 | undefined, unknown, Requirements>;
  readonly writeReceipt: (receipt: CodexResumeReceiptV1) => Effect.Effect<void, unknown, Requirements>;
}

export function parseCodexResumeHookEvent(value: unknown): CodexResumeHookEvent | undefined {
  if (
    !isJsonObject(value) ||
    value.hookEventName !== 'UserPromptSubmit' ||
    !validBoundedText(value.cwd, CODEX_RESUME_PATH_MAXIMUM_BYTES) ||
    !validBoundedText(value.prompt, 4_096) ||
    !validBoundedText(value.sessionId, CODEX_RESUME_IDENTIFIER_MAXIMUM_BYTES) ||
    !validBoundedText(value.turnId, CODEX_RESUME_IDENTIFIER_MAXIMUM_BYTES)
  ) {
    return undefined;
  }
  return {
    cwd: value.cwd,
    hookEventName: 'UserPromptSubmit',
    prompt: value.prompt,
    sessionId: value.sessionId,
    turnId: value.turnId,
  };
}

export function codexResumePreloadDisabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  const value = environment[THREADNOTE_CODEX_RESUME_PRELOAD_ENV]?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off';
}

export function promptCarriesActiveHandoff(prompt: string): boolean {
  return prompt.includes('threadnote://') && prompt.includes('/memories/handoffs/active/');
}

export function contextBriefIsEligibleForCodexResume(projected: ProjectedContextBriefV1): boolean {
  const brief = projected.structuredContent;
  const handoff = brief.activeHandoffs[0];
  return (
    brief.mode === 'resume' &&
    brief.evidenceState === 'sufficient' &&
    brief.scope.freshness === 'fresh' &&
    brief.activeHandoffs.length === 1 &&
    brief.stalenessAndConflicts.length === 0 &&
    brief.coverage.omissions.activeHandoffs === 0 &&
    handoff?.continuationCard !== undefined &&
    handoff.freshness === 'fresh' &&
    handoff.preciseStatus === 'exact'
  );
}

export function decideCodexResumePreload<Requirements>(
  dependencies: CodexResumeDecisionDependencies<Requirements>,
  event: CodexResumeHookEvent,
  evidenceGeneration: string,
): Effect.Effect<CodexResumeHookResult, unknown, Requirements> {
  return Effect.gen(function* () {
    const current = yield* dependencies.receipt;
    if (current?.evidenceGeneration === evidenceGeneration) {
      return emptyResult('already-preloaded');
    }

    const projected = yield* dependencies.compile(event.cwd, event.prompt);
    const evidenceState = projected.structuredContent.evidenceState;
    if (!contextBriefIsEligibleForCodexResume(projected)) {
      return {...emptyResult('ineligible-evidence'), evidenceState};
    }
    const outputBytes = UTF8.encode(projected.text).byteLength;
    if (
      projected.measurement.estimatedTokens > CODEX_RESUME_ADDITIONAL_CONTEXT_LIMIT ||
      outputBytes > projected.maximumBytes
    ) {
      return {
        ...emptyResult('over-limit'),
        estimatedTokens: projected.measurement.estimatedTokens,
        evidenceState: 'sufficient' as const,
        outputBytes,
      };
    }
    const evidenceHash = yield* sha256Hex(projected.text);
    yield* dependencies.deliver(projected.text);
    yield* dependencies
      .writeReceipt({evidenceGeneration, evidenceHash, version: CODEX_RESUME_RECEIPT_VERSION})
      .pipe(Effect.ignore);
    return {
      context: projected.text,
      estimatedTokens: projected.measurement.estimatedTokens,
      evidenceState: 'sufficient' as const,
      outputBytes,
      outcome: 'injected' as const,
    };
  });
}

export function renderCodexResumeHookOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: context},
  });
}

export function runCodexResumeHook(config: RuntimeConfig, options: {readonly diagnostic?: boolean} = {}) {
  // UserPromptSubmit must fail open. Every lookup and local receipt operation is
  // bounded; an unavailable preload yields no stdout and never blocks the turn.
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const system = yield* SystemInfo;
    const payload = yield* readHookPayload();
    const event = parseCodexResumeHookEvent(payload);
    let result: CodexResumeHookResult;

    if (codexResumePreloadDisabled(system.environment())) {
      result = emptyResult('disabled');
    } else if (event === undefined) {
      result = emptyResult('invalid-input');
    } else if (promptCarriesActiveHandoff(event.prompt)) {
      result = emptyResult('manual-context');
    } else {
      result = yield* runEligibleCodexResumeHook(config, event).pipe(
        Effect.timeoutOrElse({
          duration: CODEX_RESUME_HOOK_TIMEOUT,
          orElse: () => Effect.succeed(emptyResult('lookup-unavailable')),
        }),
        Effect.orElseSucceed(() => emptyResult('lookup-unavailable')),
      );
    }

    const completedAt = yield* Clock.currentTimeMillis;
    yield* recordCodexResumePreloadValueEvent(config.agentContextHome, {
      durationMilliseconds: Math.max(0, completedAt - startedAt),
      estimatedTokens: result.estimatedTokens,
      ...(result.evidenceState === undefined ? {} : {evidenceState: result.evidenceState}),
      outcome: result.outcome,
      outputBytes: result.outputBytes,
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(completedAt)),
    }).pipe(Effect.timeoutOrElse({duration: '250 millis', orElse: () => Effect.void}), Effect.ignore);
    if (options.diagnostic) yield* Console.error(`threadnote codex-resume-hook: ${result.outcome}`);
  }).pipe(
    Effect.catchCause(() =>
      options.diagnostic ? Console.error('threadnote codex-resume-hook: lookup-unavailable') : Effect.void,
    ),
  );
}

const runEligibleCodexResumeHook = Effect.fn('hooks.runCodexResumeEligible')(function* (
  config: RuntimeConfig,
  event: CodexResumeHookEvent,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  if (!pathService.isAbsolute(event.cwd)) return emptyResult('invalid-input');
  const repository = yield* resolveRepositoryIdentity(event.cwd);
  const worktree = yield* worktreeBuildRequestState(repository);
  const canonicalMutationGeneration = yield* readCanonicalMutationGeneration(
    fs,
    pathService,
    config.agentContextHome,
    config.account,
  );
  const repositoryKey = yield* sha256Hex(`${repository.repositoryId}\n${repository.worktreeId}`);
  const receiptKey = yield* sha256Hex(`${event.sessionId}\n${repositoryKey}`);
  const evidenceGeneration = yield* sha256Hex(
    JSON.stringify({
      canonicalMutationGeneration,
      dirty: worktree.dirty,
      fingerprint: worktree.fingerprint,
      headCommit: repository.headCommit,
    }),
  );
  const receiptPath = codexResumeReceiptPath(pathService, config.agentContextHome, receiptKey);
  const lockPath = pathService.join(config.agentContextHome, 'locks', 'codex-resume-hook', `${receiptKey}.lock`);
  return yield* withExclusiveFileLock(
    fs,
    lockPath,
    RECEIPT_LOCK_OPTIONS,
    decideCodexResumePreload(
      {
        compile: (cwd, prompt) =>
          compileContextBrief(config, {
            budgetTokens: CODEX_RESUME_ADDITIONAL_CONTEXT_LIMIT,
            mode: 'resume',
            responseFormat: 'agent',
            scope: {callerCwd: cwd, kind: 'repository'},
            surface: 'codex-cli',
            task: prompt,
          }),
        deliver: context => Console.log(renderCodexResumeHookOutput(context)),
        receipt: readCodexResumeReceipt(fs, receiptPath),
        writeReceipt: receipt => writeCodexResumeReceipt(fs, pathService, receiptPath, receipt),
      },
      event,
      evidenceGeneration,
    ),
  );
});

function codexResumeReceiptPath(path: Path.Path, agentContextHome: string, receiptKey: string): string {
  return path.join(agentContextHome, 'cache', 'codex-resume-hook', 'v1', `${receiptKey}.json`);
}

function readCodexResumeReceipt(
  fs: FileSystem.FileSystem,
  receiptPath: string,
): Effect.Effect<CodexResumeReceiptV1 | undefined, never> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(receiptPath))) return undefined;
    if (Option.isSome(yield* fs.readLink(receiptPath).pipe(Effect.option))) return undefined;
    const info = yield* fs.stat(receiptPath);
    if (info.type !== 'File' || Number(info.size) > CODEX_RESUME_RECEIPT_MAXIMUM_BYTES) return undefined;
    const raw = yield* fs.readFileString(receiptPath);
    const parsed = Result.try((): unknown => JSON.parse(raw));
    if (Result.isFailure(parsed) || !isJsonObject(parsed.success)) return undefined;
    const value = parsed.success;
    return value.version === CODEX_RESUME_RECEIPT_VERSION &&
      typeof value.evidenceGeneration === 'string' &&
      /^[0-9a-f]{64}$/u.test(value.evidenceGeneration) &&
      typeof value.evidenceHash === 'string' &&
      /^[0-9a-f]{64}$/u.test(value.evidenceHash)
      ? (value as unknown as CodexResumeReceiptV1)
      : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function writeCodexResumeReceipt(
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  receiptPath: string,
  receipt: CodexResumeReceiptV1,
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    yield* fs.makeDirectory(pathService.dirname(receiptPath), {recursive: true, mode: 0o700});
    const temporary = `${receiptPath}.${yield* crypto.randomUUIDv4}.tmp`;
    yield* fs.writeFileString(temporary, `${JSON.stringify(receipt)}\n`, {flag: 'wx', mode: 0o600});
    yield* fs
      .rename(temporary, receiptPath)
      .pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  });
}

function emptyResult<Outcome extends Exclude<CodexResumePreloadOutcome, 'injected'>>(
  outcome: Outcome,
): {readonly estimatedTokens: 0; readonly outcome: Outcome; readonly outputBytes: 0} {
  return {estimatedTokens: 0, outcome, outputBytes: 0};
}

function validBoundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\0') &&
    UTF8.encode(value).byteLength <= maximumBytes
  );
}
