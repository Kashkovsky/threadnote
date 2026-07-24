import {Console, Effect, FileSystem, Path, Result, Stdio, Stream} from 'effect';
import {
  CLAUDE_SETTINGS_PATH,
  HOOK_AUTO_PRECOMPACT_TOPIC,
  HOOK_PRE_COMPACT_COMMAND,
  HOOK_SESSION_START_COMMAND,
  THREADNOTE_HOOK_MARKER,
  THREADNOTE_HOOK_MARKER_VALUE,
} from './constants.js';
import {parseAgentClient} from './mcp.js';
import {SystemInfo} from './effect/system.js';
import {runHandoff, runRecall} from './memory.js';
import {applyScrubber} from './share.js';
import {distillTrace} from './trace.js';
import type {AgentClient, HookRunnerOptions, HooksInstallOptions, JsonObject, RuntimeConfig} from './types.js';
import {checkForThreadnoteUpdate, spawnDetachedAutoUpdate} from './update-check.js';
import {expandPath, exists, isJsonObject, parseJsonConfigObject, resolveRepoName} from './utils.js';
import {getThreadnoteVersion} from './version.js';

type HookEvent = 'PreCompact' | 'SessionStart';

interface ManagedHookEntry {
  readonly event: HookEvent;
  readonly command: string;
  readonly description: string;
}

const MANAGED_HOOKS: readonly ManagedHookEntry[] = [
  {
    event: 'PreCompact',
    command: HOOK_PRE_COMPACT_COMMAND,
    description: 'Auto-store a handoff snapshot before context compaction so the next turn can recall it.',
  },
  {
    event: 'SessionStart',
    command: HOOK_SESSION_START_COMMAND,
    description: 'Pre-load the latest handoff for the current repo into the new session context.',
  },
];

export {parseAgentClient as parseHookClient};

export function runHooksInstall(config: RuntimeConfig, agent: AgentClient, options: HooksInstallOptions) {
  return Effect.gen(function* () {
    const apply = options.apply === true && options.dryRun !== true;
    const remove = options.remove === true;
    switch (agent) {
      case 'claude':
        yield* runClaudeHooksInstall({apply, remove});
        return;
      case 'codex':
        yield* printCodexHooksNotice(remove);
        return;
      case 'cursor':
        yield* printNoHooksSupported('cursor', remove);
        return;
      case 'copilot':
        yield* printNoHooksSupported('copilot', remove);
        return;
    }
  });
}

function runClaudeHooksInstall(options: {readonly apply: boolean; readonly remove: boolean}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const path = yield* expandPath(CLAUDE_SETTINGS_PATH);
    const existingRaw = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : '{}';
    const parsed = parseJsonConfigObject(existingRaw) ?? {};
    const next = options.remove ? withoutThreadnoteHooks(parsed) : withThreadnoteHooks(parsed);
    const before = JSON.stringify(parsed);
    const after = JSON.stringify(next);
    if (before === after) {
      yield* Console.log(`Claude hooks already ${options.remove ? 'absent' : 'managed'} in ${path}.`);
      return;
    }

    yield* Console.log(`${options.apply ? 'Updating' : 'Would update'} ${path}:`);
    for (const entry of MANAGED_HOOKS) {
      yield* Console.log(`  ${options.remove ? '-' : '+'} ${entry.event}: ${entry.command}`);
    }

    if (!options.apply) {
      yield* Console.log('\nRe-run with --apply to actually modify the file.');
      return;
    }

    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    const serialized = `${JSON.stringify(next, undefined, 2)}\n`;
    yield* fs.writeFileString(path, serialized, {mode: 0o600});
    yield* fs.chmod(path, 0o600);
    yield* Console.log(`${options.remove ? 'Removed' : 'Installed'} threadnote-managed Claude hooks.`);
  });
}

function withThreadnoteHooks(input: JsonObject): JsonObject {
  const hooks: Record<string, unknown> = ensureMutableObject(input.hooks);
  for (const entry of MANAGED_HOOKS) {
    const list = ensureMutableArray(hooks[entry.event]).filter(item => !isManagedThreadnoteEntry(item));
    list.push({
      [THREADNOTE_HOOK_MARKER]: THREADNOTE_HOOK_MARKER_VALUE,
      matcher: '',
      hooks: [{type: 'command', command: entry.command}],
    });
    hooks[entry.event] = list;
  }
  return {...input, hooks};
}

function withoutThreadnoteHooks(input: JsonObject): JsonObject {
  if (!isJsonObject(input.hooks)) {
    return input;
  }
  const hooks: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(input.hooks)) {
    if (!Array.isArray(value)) {
      hooks[event] = value;
      continue;
    }
    const filtered = value.filter(item => !isManagedThreadnoteEntry(item));
    if (filtered.length > 0) {
      hooks[event] = filtered;
    }
  }
  if (Object.keys(hooks).length === 0) {
    const next: Record<string, unknown> = {...input};
    delete next.hooks;
    return next;
  }
  return {...input, hooks};
}

function isManagedThreadnoteEntry(value: unknown): boolean {
  return isJsonObject(value) && value[THREADNOTE_HOOK_MARKER] === THREADNOTE_HOOK_MARKER_VALUE;
}

function ensureMutableObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? {...value} : {};
}

function ensureMutableArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function printCodexHooksNotice(remove: boolean) {
  if (remove) {
    return Console.log('Codex CLI does not expose a managed hook surface today, so there is nothing to remove.');
  }
  return Console.log(
    [
      'Codex CLI does not currently expose lifecycle hooks (no PreCompact or SessionStart analog).',
      'Threadnote already installs Codex user instructions at ~/.codex/AGENTS.md; that remains the active guidance surface.',
      'If a future Codex release adds hook events, threadnote will pick them up via `install-hooks codex`.',
    ].join('\n'),
  );
}

function printNoHooksSupported(agent: AgentClient, remove: boolean) {
  if (remove) {
    return Console.log(`${agent} does not expose a hook surface; nothing to remove.`);
  }
  return Console.log(
    [
      `${agent} does not expose agent-mode hooks today.`,
      'Threadnote already installs user-level instructions for this agent; that remains the active guidance surface.',
      'Hooks support will be added if the agent gains a hook surface upstream.',
    ].join('\n'),
  );
}

export const hasManagedClaudeHooks = Effect.fn('hooks.hasManagedClaudeHooks')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* expandPath(CLAUDE_SETTINGS_PATH);
  if (!(yield* exists(path))) {
    return false;
  }
  const raw = yield* fs.readFileString(path);
  const parsed = parseJsonConfigObject(raw);
  if (!parsed || !isJsonObject(parsed.hooks)) {
    return false;
  }
  for (const value of Object.values(parsed.hooks)) {
    if (!Array.isArray(value)) {
      continue;
    }
    if (value.some(item => isManagedThreadnoteEntry(item))) {
      return true;
    }
  }
  return false;
});

export function runPreCompactHook(config: RuntimeConfig, options: HookRunnerOptions = {}) {
  // Hooks must never block compaction. Anything that throws here gets swallowed
  // and the process still exits 0 — the worst-case is a missed snapshot.
  return Effect.gen(function* () {
    const project = (yield* resolveRepoName()) ?? 'general';
    const {sessionId, trace} = yield* captureTraceContext();
    yield* runHandoff(config, {
      blockers: '- none recorded',
      dryRun: options.dryRun === true,
      nextStep:
        'Continue from this auto-snapshot. A manual `threadnote handoff` will produce a richer write-up if you have more context.',
      project,
      sessionId,
      sourceAgentClient: 'claude',
      task: 'Auto-snapshot captured at Claude PreCompact (deterministic safety net before context compaction).',
      tests: '- not recorded (auto-snapshot)',
      topic: HOOK_AUTO_PRECOMPACT_TOPIC,
      trace,
    });
  }).pipe(
    Effect.catch(error =>
      Console.error(
        `threadnote pre-compact-hook: snapshot skipped (${error instanceof Error ? error.message : String(error)})`,
      ),
    ),
  );
}

export function runSessionStartHook(config: RuntimeConfig, options: HookRunnerOptions = {}) {
  // Hooks must never block session start. Failures fall through quietly so the
  // user just gets a normal session without injected context.
  return Effect.gen(function* () {
    const project = yield* resolveRepoName();
    if (!project) {
      return;
    }
    yield* emitUpdateBannerIfOutdated(config);
    yield* Console.log(`## Threadnote — latest context for ${project}\n`);
    yield* runRecall(config, {
      dryRun: options.dryRun === true,
      inferScope: true,
      nodeLimit: '5',
      // Keep "current branch" here so recall enriches the query with local git/workspace terms.
      query: `${project} current branch latest handoff durable feature memory`,
    });
  }).pipe(
    Effect.catch(error =>
      Console.error(
        `threadnote session-start-hook: recall skipped (${error instanceof Error ? error.message : String(error)})`,
      ),
    ),
  );
}

interface TraceContext {
  readonly sessionId?: string;
  readonly trace?: string;
}

/**
 * Reads Claude's PreCompact stdin payload and distills the referenced
 * transcript into a short, scrubbed trace. Entirely best-effort: any failure
 * (no stdin, unreadable transcript, unstable format, secret blocker) yields an
 * empty context so the pre-compact snapshot still writes its state-only
 * handoff. Never throws.
 */
const captureTraceContext = Effect.fn('hooks.captureTraceContext')(() =>
  Effect.gen(function* () {
    const payload = yield* readHookPayload();
    if (!payload) {
      return {};
    }
    const rawTrace = payload.transcriptPath ? yield* distillTrace(payload.transcriptPath) : undefined;
    return {sessionId: payload.sessionId, trace: rawTrace ? scrubTrace(rawTrace) : undefined};
  }).pipe(Effect.catch(() => Effect.succeed({} as TraceContext))),
);

/** Redacts soft leaks; drops the trace on a hard credential blocker. */
function scrubTrace(trace: string): string | undefined {
  const result = applyScrubber(trace, {redact: true});
  return result.blocker ? undefined : result.cleaned;
}

const readHookPayload = Effect.fn('hooks.readPayload')(function* () {
  const system = yield* SystemInfo;
  if (system.stdinIsTTY) {
    return undefined;
  }
  const raw = yield* readStdinWithTimeout(1500, 512 * 1024);
  if (!raw.trim()) {
    return undefined;
  }
  const parsedResult = Result.try((): unknown => JSON.parse(raw));
  if (Result.isFailure(parsedResult)) {
    return undefined;
  }
  const parsed = parsedResult.success;
  if (!isJsonObject(parsed)) {
    return undefined;
  }
  return {
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
    transcriptPath: typeof parsed.transcript_path === 'string' ? parsed.transcript_path : undefined,
  };
});

const readStdinWithTimeout = Effect.fn('hooks.readStdin')(function* (timeoutMs: number, maxBytes: number) {
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFold(
      () => '',
      (output, chunk) => `${output}${chunk}`.slice(0, maxBytes),
    ),
    Effect.timeoutOrElse({duration: timeoutMs, orElse: () => Effect.succeed('')}),
    Effect.catch(() => Effect.succeed('')),
  );
});

function emitUpdateBannerIfOutdated(config: RuntimeConfig) {
  // Cheap, daily-cached check that nags users to upgrade. Failures are folded
  // in the Effect error channel so a flaky registry never breaks session start.
  // With THREADNOTE_AUTO_UPDATE=1, the same code path
  // spawns `threadnote update --yes` as a detached background process and
  // tells the user the new version will be active next session.
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const result = yield* checkForThreadnoteUpdate({
      cachePath: path.join(config.agentContextHome, '.update-state.json'),
      currentVersion: yield* getThreadnoteVersion(),
    });
    if (!result || !result.outdated) {
      return;
    }
    if (system.environment().THREADNOTE_AUTO_UPDATE === '1') {
      yield* Console.log(
        `[threadnote] v${result.latestVersion} available (current v${result.currentVersion}). Auto-updating in the background; the new version takes effect next session.\n`,
      );
      yield* spawnDetachedAutoUpdate();
      return;
    }
    yield* Console.log(
      `[threadnote] v${result.latestVersion} available (current v${result.currentVersion}). Run: threadnote update\n`,
    );
  }).pipe(Effect.catch(() => Effect.void));
}
