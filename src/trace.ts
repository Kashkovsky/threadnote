import {readFile} from 'node:fs/promises';

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_INTENTS = 5;
const MAX_INTENT_CHARS = 160;
const MAX_TOOLS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  const joined = parts.join(' ').trim();
  return joined || undefined;
}

function extractToolNames(content: unknown): readonly string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const names: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part.type === 'tool_use' && typeof part.name === 'string') {
      names.push(part.name);
    }
  }
  return names;
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Best-effort, heuristic distillation of an agent transcript (Claude Code
 * JSONL) into a short summary: event count, tools used, and recent user
 * intents. Returns undefined on any read/parse failure or empty transcript so
 * the caller can fall back to a state-only handoff. The transcript format is
 * agent-specific and unstable, so every field is defensive. Callers MUST scrub
 * the result before persisting — user intents can contain secrets.
 */
export async function distillTrace(transcriptPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }
  if (!raw.trim()) {
    return undefined;
  }
  const body = raw.length > MAX_TRANSCRIPT_BYTES ? raw.slice(raw.length - MAX_TRANSCRIPT_BYTES) : raw;
  let events = 0;
  const tools = new Set<string>();
  const intents: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    events += 1;
    const message = isRecord(parsed.message) ? parsed.message : parsed;
    const role =
      typeof message.role === 'string' ? message.role : typeof parsed.type === 'string' ? parsed.type : undefined;
    if (role === 'user') {
      const text = extractText(message.content);
      if (text) {
        intents.push(truncate(text, MAX_INTENT_CHARS));
      }
    } else if (role === 'assistant') {
      for (const name of extractToolNames(message.content)) {
        tools.add(name);
      }
    }
  }
  if (events === 0) {
    return undefined;
  }
  const lines = [`- ${events} transcript events`];
  if (tools.size > 0) {
    lines.push(`- tools used: ${[...tools].slice(0, MAX_TOOLS).join(', ')}`);
  }
  const recentIntents = intents.slice(-MAX_INTENTS);
  if (recentIntents.length > 0) {
    lines.push('- recent intents:');
    for (const intent of recentIntents) {
      lines.push(`  - ${intent}`);
    }
  }
  return lines.join('\n');
}
