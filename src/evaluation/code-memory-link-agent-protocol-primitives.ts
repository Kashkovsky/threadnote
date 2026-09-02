import {sha256HexSync} from '../crypto/sha256.js';

export type CanonicalJsonValue =
  boolean | null | number | string | readonly CanonicalJsonValue[] | {readonly [key: string]: CanonicalJsonValue};

const HASH = /^[0-9a-f]{64}$/u;
const MAXIMUM_TEXT_BYTES = 1_024 * 1_024;
const UTF8 = new TextEncoder();

export function normalizeJsonValue(value: unknown, label: string, depth = 0): CanonicalJsonValue {
  if (depth > 64) invalid(`${label} exceeds the maximum nesting depth`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) invalid(`${label} array is too large`);
    return value.map(entry => normalizeJsonValue(entry, label, depth + 1));
  }
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${label} must contain only JSON values`);
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(compareStrings);
  if (keys.length > 10_000) invalid(`${label} object is too large`);
  return Object.fromEntries(keys.map(key => [key, normalizeJsonValue(object[key], label, depth + 1)]));
}

export function validateCodeMemoryLinkThreadSettingsUpdateV1(value: unknown, threadId: string): void {
  const params = record(value, 'thread/settings/updated params');
  matchingIdentifier(params.threadId, threadId, 'thread/settings/updated thread id');
  const settings = record(params.threadSettings, 'thread/settings/updated settings');
  const sandbox = record(settings.sandboxPolicy, 'thread/settings/updated sandbox');
  if (
    settings.approvalPolicy !== 'untrusted' ||
    settings.approvalsReviewer !== 'user' ||
    settings.activePermissionProfile !== null ||
    sandbox.type !== 'workspaceWrite' ||
    !Array.isArray(sandbox.writableRoots) ||
    sandbox.writableRoots.length !== 0 ||
    sandbox.networkAccess !== false ||
    sandbox.excludeTmpdirEnvVar !== true ||
    sandbox.excludeSlashTmp !== true
  ) {
    invalid('thread/settings/updated differs from the sealed workspace policy');
  }
  boundedText(settings.cwd, 'thread/settings/updated cwd', 4_096);
}

export function assertSyntheticArtifactContent(
  artifact: {readonly content: string; readonly mediaType: 'application/json' | 'text/plain'},
  label: string,
): void {
  if (artifact.mediaType === 'text/plain') return assertSyntheticText(artifact.content, `${label} content`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.content) as unknown;
  } catch {
    invalid(`${label} is not valid JSON`);
  }
  const normalized = normalizeJsonValue(parsed, label);
  assertSyntheticJsonValue(normalized, label);
  if (artifact.content !== JSON.stringify(normalized)) {
    invalid(`${label} JSON must use the canonical privacy-safe serialization`);
  }
}

export function assertSyntheticText(value: string, label: string): void {
  if (!/^(?:[A-Za-z0-9_.:-]+(?:=[A-Za-z0-9_.:-]+)?(?:\n|$))*$/u.test(value)) {
    invalid(`${label} must contain only privacy-safe synthetic tokens`);
  }
}

export function assertSyntheticJsonValue(value: CanonicalJsonValue, label: string): void {
  if (typeof value === 'string') {
    if (!/^[A-Za-z0-9_.:-]{0,256}$/u.test(value)) invalid(`${label} contains non-synthetic text`);
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) return void value.forEach(entry => assertSyntheticJsonValue(entry, label));
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(key)) invalid(`${label} contains a non-synthetic key`);
    assertSyntheticJsonValue(entry, label);
  }
}

export function parseStepTokenBudget(value: unknown): {readonly steps: number; readonly tokens: number} {
  const budget = record(value, 'task budget');
  exactKeys(budget, ['steps', 'tokens'], 'task budget');
  const steps = positiveInteger(budget.steps, 'task step budget');
  const tokens = positiveInteger(budget.tokens, 'task token budget');
  if (tokens > 1_000_000 || steps > 10_000) invalid('task budget exceeds the protocol maximum');
  return {steps, tokens};
}

export function normalizeContextBriefProxyRequest(value: unknown, prompt: string): Readonly<Record<string, unknown>> {
  const request = record(value, 'Context Brief proxy request');
  exactKeys(
    request,
    ['budgetTokens', 'callerCwd', 'codeRefs', 'mode', 'project', 'task', 'workset'],
    'Context Brief proxy request',
    true,
  );
  if (request.task !== prompt) invalid('Context Brief proxy request must use the exact sealed task prompt');
  let codeRefs: readonly string[] | undefined;
  if (request.codeRefs !== undefined) {
    if (!Array.isArray(request.codeRefs) || request.codeRefs.length > 8) {
      invalid('Context Brief proxy codeRefs must be an array with at most eight values');
    }
    codeRefs = request.codeRefs.map((entry, index) =>
      boundedText(entry, `Context Brief proxy codeRefs[${index}]`, 4_096),
    );
    unique(codeRefs, 'Context Brief proxy codeRefs');
  }
  const budgetTokens =
    request.budgetTokens === undefined
      ? undefined
      : positiveInteger(request.budgetTokens, 'Context Brief token budget');
  if (budgetTokens !== undefined && budgetTokens > 1_000_000) invalid('Context Brief token budget exceeds the maximum');
  return {
    ...(budgetTokens === undefined ? {} : {budgetTokens}),
    ...(request.callerCwd === undefined ? {} : {callerCwd: boundedText(request.callerCwd, 'callerCwd', 16_384)}),
    ...(codeRefs === undefined ? {} : {codeRefs}),
    ...(request.mode === undefined
      ? {}
      : {
          mode: literal(request.mode, ['brief', 'explain', 'impact', 'locate', 'trace'] as const, 'Context Brief mode'),
        }),
    ...(request.project === undefined ? {} : {project: boundedText(request.project, 'project', 128)}),
    task: prompt,
    ...(request.workset === undefined ? {} : {workset: boundedText(request.workset, 'workset', 128)}),
  };
}

export function hashArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid(`${label} must be an array with at most ${maximum} entries`);
  }
  const hashes = value.map((entry, index) => matchingHash(entry, `${label} ${index + 1}`));
  canonicalUnique(hashes, label);
  return hashes;
}

export function literalArray<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): readonly T[number][] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const entries = value.map(entry => literal(entry, allowed, label));
  canonicalUnique(entries, label);
  return entries;
}

export function matchingIdentifier(value: unknown, expected: string, label: string): void {
  if (boundedText(value, label, 256) !== expected) invalid(`${label} does not match the active trial`);
}

export function matchingHash(value: unknown, label: string): string {
  return matchingText(value, HASH, `${label} hash`);
}

export function matchingText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

export function boundedText(value: unknown, label: string, maximumBytes: number, normalize = true): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  const text = normalize ? value.normalize('NFKC').trim() : value;
  if (
    !text.trim() ||
    UTF8.encode(text).byteLength > Math.min(maximumBytes, MAXIMUM_TEXT_BYTES) ||
    containsUnsupportedControl(text)
  ) {
    invalid(`${label} must be non-empty bounded text without control characters`);
  }
  return text;
}

export function boundedUtf8Content(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  if (UTF8.encode(value).byteLength > maximumBytes || containsUnsupportedControl(value)) {
    invalid(`${label} must be bounded UTF-8 text without unsupported control characters`);
  }
  return value;
}

export function protocolVersion(value: unknown, label: string): 1 {
  if (value !== 1) invalid(`${label} version must be 1`);
  return 1;
}

export function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`${label} must be a positive safe integer`);
  return value as number;
}

export function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} must be a non-negative safe integer`);
  return value as number;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

export function literal<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    invalid(`${label} must be one of ${allowed.join(', ')}`);
  }
  return value;
}

export function canonicalUnique(values: readonly string[], label: string): void {
  unique(values, label);
  if (values.some((value, index) => index > 0 && value <= values[index - 1])) {
    invalid(`${label} must use canonical ascending order`);
  }
}

export function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

export function uniqueMap<T>(values: readonly T[], key: (value: T) => string, label: string): ReadonlyMap<string, T> {
  const entries = values.map(value => [key(value), value] as const);
  unique(
    entries.map(([entryKey]) => entryKey),
    label,
  );
  return new Map(entries);
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  optional = false,
): void {
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  if (optional) {
    const unexpected = actual.filter(key => !expected.includes(key));
    if (unexpected.length > 0) invalid(`${label} has unsupported field ${unexpected[0]}`);
    return;
  }
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

export function boundedRequestId(value: unknown, label: string): string | number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') return boundedText(value, label, 256);
  return invalid(`${label} is invalid`);
}

export function validateResolvedServerRequestV1(params: Record<string, unknown>, threadId: string): void {
  exactKeys(params, ['requestId', 'threadId'], 'resolved server request');
  matchingIdentifier(params.threadId, threadId, 'resolved server request thread id');
  boundedRequestId(params.requestId, 'resolved server request id');
}

export function protocolDigest(domain: string, value: unknown): string {
  return sha256HexSync(`code-memory-link-agent-protocol-v1\0${domain}\0${JSON.stringify(value)}\n`);
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link real-agent protocol: ${message}.`);
}

function containsUnsupportedControl(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}
