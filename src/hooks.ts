import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {
  CLAUDE_SETTINGS_PATH,
  HOOK_AUTO_PRECOMPACT_TOPIC,
  HOOK_PRE_COMPACT_COMMAND,
  HOOK_SESSION_START_COMMAND,
  THREADNOTE_HOOK_MARKER,
  THREADNOTE_HOOK_MARKER_VALUE,
} from './constants.js';
import {parseAgentClient} from './mcp.js';
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

export async function runHooksInstall(
  config: RuntimeConfig,
  agent: AgentClient,
  options: HooksInstallOptions,
): Promise<void> {
  const apply = options.apply === true && options.dryRun !== true;
  const remove = options.remove === true;
  switch (agent) {
    case 'claude':
      await runClaudeHooksInstall({apply, remove});
      return;
    case 'codex':
      printCodexHooksNotice(remove);
      return;
    case 'cursor':
      printNoHooksSupported('cursor', remove);
      return;
    case 'copilot':
      printNoHooksSupported('copilot', remove);
      return;
  }
}

async function runClaudeHooksInstall(options: {readonly apply: boolean; readonly remove: boolean}): Promise<void> {
  const path = expandPath(CLAUDE_SETTINGS_PATH);
  const existingRaw = (await exists(path)) ? await readFile(path, 'utf8') : '{}';
  const parsed = parseJsonConfigObject(existingRaw) ?? {};
  const next = options.remove ? withoutThreadnoteHooks(parsed) : withThreadnoteHooks(parsed);
  const before = JSON.stringify(parsed);
  const after = JSON.stringify(next);
  if (before === after) {
    console.log(`Claude hooks already ${options.remove ? 'absent' : 'managed'} in ${path}.`);
    return;
  }

  console.log(`${options.apply ? 'Updating' : 'Would update'} ${path}:`);
  for (const entry of MANAGED_HOOKS) {
    console.log(`  ${options.remove ? '-' : '+'} ${entry.event}: ${entry.command}`);
  }

  if (!options.apply) {
    console.log('\nRe-run with --apply to actually modify the file.');
    return;
  }

  await mkdir(dirname(path), {recursive: true});
  const serialized = `${JSON.stringify(next, undefined, 2)}\n`;
  await writeFile(path, serialized, {encoding: 'utf8', mode: 0o600});
  await chmod(path, 0o600);
  console.log(`${options.remove ? 'Removed' : 'Installed'} threadnote-managed Claude hooks.`);
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

function printCodexHooksNotice(remove: boolean): void {
  if (remove) {
    console.log('Codex CLI does not expose a managed hook surface today, so there is nothing to remove.');
    return;
  }
  console.log(
    [
      'Codex CLI does not currently expose lifecycle hooks (no PreCompact or SessionStart analog).',
      'Threadnote already installs Codex user instructions at ~/.codex/AGENTS.md; that remains the active guidance surface.',
      'If a future Codex release adds hook events, threadnote will pick them up via `install-hooks codex`.',
    ].join('\n'),
  );
}

function printNoHooksSupported(agent: AgentClient, remove: boolean): void {
  if (remove) {
    console.log(`${agent} does not expose a hook surface; nothing to remove.`);
    return;
  }
  console.log(
    [
      `${agent} does not expose agent-mode hooks today.`,
      'Threadnote already installs user-level instructions for this agent; that remains the active guidance surface.',
      'Hooks support will be added if the agent gains a hook surface upstream.',
    ].join('\n'),
  );
}

export async function hasManagedClaudeHooks(): Promise<boolean> {
  const path = expandPath(CLAUDE_SETTINGS_PATH);
  if (!(await exists(path))) {
    return false;
  }
  const raw = await readFile(path, 'utf8');
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
}

export async function runPreCompactHook(config: RuntimeConfig, options: HookRunnerOptions = {}): Promise<void> {
  // Hooks must never block compaction. Anything that throws here gets swallowed
  // and the process still exits 0 — the worst-case is a missed snapshot.
  try {
    const project = (await resolveRepoName()) ?? 'general';
    const {sessionId, trace} = await captureTraceContext();
    await runHandoff(config, {
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
  } catch (err: unknown) {
    process.stderr.write(
      `threadnote pre-compact-hook: snapshot skipped (${err instanceof Error ? err.message : String(err)})\n`,
    );
  }
}

export async function runSessionStartHook(config: RuntimeConfig, options: HookRunnerOptions = {}): Promise<void> {
  // Hooks must never block session start. Failures fall through quietly so the
  // user just gets a normal session without injected context.
  try {
    const project = await resolveRepoName();
    if (!project) {
      return;
    }
    await emitUpdateBannerIfOutdated(config);
    process.stdout.write(`## Threadnote — latest context for ${project}\n\n`);
    await runRecall(config, {
      dryRun: options.dryRun === true,
      inferScope: true,
      nodeLimit: '5',
      // Keep "current branch" here so recall enriches the query with local git/workspace terms.
      query: `${project} current branch latest handoff durable feature memory`,
    });
  } catch (err: unknown) {
    process.stderr.write(
      `threadnote session-start-hook: recall skipped (${err instanceof Error ? err.message : String(err)})\n`,
    );
  }
}

interface TraceContext {
  readonly sessionId?: string;
  readonly trace?: string;
}

interface HookPayload {
  readonly sessionId?: string;
  readonly transcriptPath?: string;
}

/**
 * Reads Claude's PreCompact stdin payload and distills the referenced
 * transcript into a short, scrubbed trace. Entirely best-effort: any failure
 * (no stdin, unreadable transcript, unstable format, secret blocker) yields an
 * empty context so the pre-compact snapshot still writes its state-only
 * handoff. Never throws.
 */
async function captureTraceContext(): Promise<TraceContext> {
  try {
    const payload = await readHookPayload();
    if (!payload) {
      return {};
    }
    const rawTrace = payload.transcriptPath ? await distillTrace(payload.transcriptPath) : undefined;
    return {sessionId: payload.sessionId, trace: rawTrace ? scrubTrace(rawTrace) : undefined};
  } catch {
    return {};
  }
}

/** Redacts soft leaks; drops the trace on a hard credential blocker. */
function scrubTrace(trace: string): string | undefined {
  const result = applyScrubber(trace, {redact: true});
  return result.blocker ? undefined : result.cleaned;
}

async function readHookPayload(): Promise<HookPayload | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }
  const raw = await readStdinWithTimeout(1500, 512 * 1024);
  if (!raw.trim()) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) {
    return undefined;
  }
  return {
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
    transcriptPath: typeof parsed.transcript_path === 'string' ? parsed.transcript_path : undefined,
  };
}

function readStdinWithTimeout(timeoutMs: number, maxBytes: number): Promise<string> {
  return new Promise(resolve => {
    const stdin = process.stdin;
    let data = '';
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      stdin.off('data', onData);
      stdin.off('end', finish);
      stdin.off('error', finish);
      clearTimeout(timer);
      stdin.pause();
      resolve(data);
    };
    const onData = (chunk: string): void => {
      data += chunk;
      if (data.length >= maxBytes) {
        data = data.slice(0, maxBytes);
        finish();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', finish);
    stdin.resume();
  });
}

async function emitUpdateBannerIfOutdated(config: RuntimeConfig): Promise<void> {
  // Cheap, daily-cached check that nags users to upgrade. The check is wrapped
  // in try/catch so a flaky registry or unreachable network never breaks the
  // session-start path. With THREADNOTE_AUTO_UPDATE=1, the same code path
  // spawns `threadnote update --yes` as a detached background process and
  // tells the user the new version will be active next session.
  try {
    const result = await checkForThreadnoteUpdate({
      cachePath: join(config.agentContextHome, '.update-state.json'),
      currentVersion: getThreadnoteVersion(),
    });
    if (!result || !result.outdated) {
      return;
    }
    if (process.env.THREADNOTE_AUTO_UPDATE === '1') {
      process.stdout.write(
        `[threadnote] v${result.latestVersion} available (current v${result.currentVersion}). Auto-updating in the background; the new version takes effect next session.\n\n`,
      );
      spawnDetachedAutoUpdate();
      return;
    }
    process.stdout.write(
      `[threadnote] v${result.latestVersion} available (current v${result.currentVersion}). Run: threadnote update\n\n`,
    );
  } catch {
    // Silent: the update banner is a nice-to-have, not a session-start
    // requirement.
  }
}
