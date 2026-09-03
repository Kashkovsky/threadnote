import {sha256HexSync} from '../src/crypto/sha256.js';

export const CODE_MEMORY_LINK_CODEX_TERMINAL_VERSION = 1 as const;
export const CODE_MEMORY_LINK_CODEX_TERMINAL_MARKER = 'THREADNOTE_CODE_MEMORY_LINK_TERMINAL ' as const;

export const CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS = [
  'no-action-budget',
  'preflight-isolation',
  'process-exit',
  'provider-step-budget',
  'provider-terminal',
  'provider-token-budget',
  'turn-timeout',
  'unknown',
] as const;

export type CodeMemoryLinkCodexTerminalKind = (typeof CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS)[number];

export interface CodeMemoryLinkCodexItemCountsV1 {
  readonly agentMessage: number;
  readonly commandExecution: number;
  readonly fileChange: number;
  readonly mcpToolCall: number;
  readonly other: number;
  readonly plan: number;
  readonly reasoning: number;
  readonly userMessage: number;
}

export interface CodeMemoryLinkCodexTerminalDiagnosticsV1 {
  readonly completedItems: CodeMemoryLinkCodexItemCountsV1;
  readonly contextBriefCallStarts: number;
  readonly startedItems: CodeMemoryLinkCodexItemCountsV1;
  readonly totalTaskUsage: {readonly steps: number; readonly tokens: number};
  readonly version: 1;
}

export interface CodeMemoryLinkCodexTerminalReceiptV1 {
  readonly diagnosticHash: string;
  readonly kind: CodeMemoryLinkCodexTerminalKind;
  readonly version: typeof CODE_MEMORY_LINK_CODEX_TERMINAL_VERSION;
}

export class CodeMemoryLinkCodexTerminalError extends Error {
  readonly diagnostics: CodeMemoryLinkCodexTerminalDiagnosticsV1 | null;
  readonly kind: CodeMemoryLinkCodexTerminalKind;

  constructor(
    kind: CodeMemoryLinkCodexTerminalKind,
    message: string,
    diagnostics: CodeMemoryLinkCodexTerminalDiagnosticsV1 | null = null,
  ) {
    super(message);
    this.name = 'CodeMemoryLinkCodexTerminalError';
    this.diagnostics = diagnostics;
    this.kind = kind;
  }
}

export function createCodeMemoryLinkCodexTerminalReceipt(
  kind: CodeMemoryLinkCodexTerminalKind,
): CodeMemoryLinkCodexTerminalReceiptV1 {
  return {
    diagnosticHash: sha256HexSync(`threadnote-code-memory-link-terminal-v1\0${kind}`),
    kind,
    version: CODE_MEMORY_LINK_CODEX_TERMINAL_VERSION,
  };
}

export function classifyCodeMemoryLinkCodexTerminal(error: unknown): CodeMemoryLinkCodexTerminalKind {
  if (error instanceof CodeMemoryLinkCodexTerminalError) return error.kind;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /timed out waiting for (?:a )?Codex app-server|timed out waiting for a Codex app-server notification/iu.test(
      message,
    )
  ) {
    return 'turn-timeout';
  }
  if (/exceeded the sealed provider inference-step budget/iu.test(message)) return 'provider-step-budget';
  if (/exceeded the sealed provider token budget|provider-reported usage exceeded/iu.test(message)) {
    return 'provider-token-budget';
  }
  if (/app-server (?:exited early|request failed)|turn did not complete successfully/iu.test(message)) {
    return 'provider-terminal';
  }
  if (
    /approval was rejected|changed the sealed turn settings|Context Brief proxy did not become ready|did not confirm the sealed turn settings|did not enforce|did not honor|unexpected .*server|unexpected .*tool|MCP inventory/iu.test(
      message,
    )
  ) {
    return 'preflight-isolation';
  }
  return 'unknown';
}

export function formatCodeMemoryLinkCodexTerminalReceipt(error: unknown): string {
  const receipt = createCodeMemoryLinkCodexTerminalReceipt(classifyCodeMemoryLinkCodexTerminal(error));
  return `${CODE_MEMORY_LINK_CODEX_TERMINAL_MARKER}${JSON.stringify(receipt)}`;
}

export function parseCodeMemoryLinkCodexTerminalReceipt(stderr: string): CodeMemoryLinkCodexTerminalReceiptV1 | null {
  const candidates = stderr.split(/\r?\n/u).filter(line => line.startsWith(CODE_MEMORY_LINK_CODEX_TERMINAL_MARKER));
  if (candidates.length !== 1) return null;
  let value: unknown;
  try {
    value = JSON.parse(candidates[0].slice(CODE_MEMORY_LINK_CODEX_TERMINAL_MARKER.length)) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(['diagnosticHash', 'kind', 'version']) ||
    receipt.version !== CODE_MEMORY_LINK_CODEX_TERMINAL_VERSION ||
    typeof receipt.kind !== 'string' ||
    !CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS.includes(receipt.kind as CodeMemoryLinkCodexTerminalKind) ||
    typeof receipt.diagnosticHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(receipt.diagnosticHash)
  ) {
    return null;
  }
  const expected = createCodeMemoryLinkCodexTerminalReceipt(receipt.kind as CodeMemoryLinkCodexTerminalKind);
  return receipt.diagnosticHash === expected.diagnosticHash ? expected : null;
}
