#!/usr/bin/env bun

/* oxlint-disable effecttsgo/node-builtin-import -- This copied sealed program must be self-contained. */
import {createHash} from 'node:crypto';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {isAbsolute, join, resolve, sep} from 'node:path';

const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const MAXIMUM_RESULT_BYTES = 64 * 1_024;

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2));
  const requestedRoot = resolve(options.repository);
  if (!isAbsolute(options.repository) || requestedRoot !== options.repository) fail('--repository must be normalized');
  const rootMetadata = await lstat(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail('repository must be a non-symlink directory');
  const canonicalRoot = await realpath(requestedRoot);

  const result = await readRequiredSyntheticJson(canonicalRoot, 'result.json');
  const artifacts = [artifact(options.taskId, 'result.json', result)];
  if (options.guardRequired) {
    artifacts.push(artifact(options.taskId, 'guard.json', await readGuardJson(canonicalRoot, options.taskId)));
  }
  artifacts.sort((left, right) =>
    left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0,
  );
  process.stdout.write(`${JSON.stringify({artifacts, version: 1})}\n`);
}

function parseArguments(arguments_: readonly string[]): {
  readonly guardRequired: boolean;
  readonly repository: string;
  readonly taskId: string;
} {
  let guardRequired = false;
  let repository: string | undefined;
  let taskId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--guard-required') guardRequired = true;
    else if (argument === '--repository') repository = required(arguments_[++index], argument);
    else if (argument === '--task-id') taskId = required(arguments_[++index], argument);
    else fail(`unsupported option ${argument ?? '<missing>'}`);
  }
  if (repository === undefined || taskId === undefined) fail('judge requires --repository and --task-id');
  if (!TASK_ID.test(taskId)) fail('task id is invalid');
  return {guardRequired, repository, taskId};
}

function outputArtifactId(taskId: string, path: 'guard.json' | 'result.json'): string {
  const value = {path, scope: 'judge-output', taskId};
  return `art_${sha256(`threadnote-code-memory-link-agent-suite-v1\0art\0${JSON.stringify(value)}\n`).slice(0, 32)}`;
}

function artifact(taskId: string, path: 'guard.json' | 'result.json', value: unknown) {
  const content = JSON.stringify(value);
  return {
    artifactId: outputArtifactId(taskId, path),
    content,
    mediaType: 'application/json' as const,
    sha256: sha256(content),
  };
}

async function readRequiredSyntheticJson(root: string, relativePath: string): Promise<unknown> {
  const path = join(root, relativePath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    fail(`${relativePath} must be one non-linked regular file`);
  }
  if (metadata.size > MAXIMUM_RESULT_BYTES) fail(`${relativePath} exceeds the sealed byte limit`);
  const canonical = await realpath(path);
  if (canonical !== path || !canonical.startsWith(`${root}${sep}`)) fail(`${relativePath} escaped the repository`);
  const raw = new TextDecoder('utf-8', {fatal: true}).decode(await readFile(canonical));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail(`${relativePath} must contain UTF-8 JSON`);
  }
  const normalized = normalizeJson(parsed);
  assertSyntheticJson(normalized);
  return normalized;
}

async function readGuardJson(root: string, taskId: string): Promise<unknown> {
  try {
    return await readRequiredSyntheticJson(root, 'guard.json');
  } catch (cause) {
    if (isMissing(cause)) return guardFailure(taskId, 'missing');
    return guardFailure(taskId, 'invalid');
  }
}

function guardFailure(taskId: string, state: 'invalid' | 'missing'): unknown {
  return {caseId: taskId, role: 'guard', state, version: 1};
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as {code?: unknown}).code === 'ENOENT';
}

function normalizeJson(value: unknown, depth = 0): unknown {
  if (depth > 32) fail('result.json exceeds the maximum nesting depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('result.json contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(entry => normalizeJson(entry, depth + 1));
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('result.json contains a non-JSON value');
  }
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map(key => [key, normalizeJson(object[key], depth + 1)]),
  );
}

function assertSyntheticJson(value: unknown): void {
  if (typeof value === 'string') {
    if (!/^[A-Za-z0-9_.:-]{0,256}$/u.test(value)) fail('result.json contains non-synthetic text');
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    value.forEach(assertSyntheticJson);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(key)) fail('result.json contains a non-synthetic key');
    assertSyntheticJson(entry);
  }
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) fail(`${option} requires a value`);
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message: string): never {
  throw new Error(`Code Memory Link static judge: ${message}.`);
}

await main();
