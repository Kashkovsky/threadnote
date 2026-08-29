import {sha256HexSync} from '../crypto/sha256.js';
import type {MemoryReadMode, MemoryReadPosition} from '../memory/read_projection.js';
import type {AuthorizedRemotePrincipal} from './authorization.js';

export const REMOTE_MEMORY_READ_CURSOR_TTL_MILLISECONDS = 10 * 60_000;
export const REMOTE_MEMORY_READ_CURSOR_MAXIMUM_BYTES = 8_192;

const REMOTE_MEMORY_READ_CURSOR = /^tnrr1\.([0-9a-f]{64})\.([A-Za-z0-9_-]+)$/u;
const UTF8 = new TextEncoder();

export interface RemoteMemoryReadCursorState {
  readonly contentHash: string;
  readonly expiresAt: number;
  readonly mode: MemoryReadMode;
  readonly position: MemoryReadPosition;
  readonly revision: string;
  readonly section?: string;
  readonly uri: string;
}

export function remoteMemoryReadCursorKey(principal: AuthorizedRemotePrincipal): string {
  return sha256HexSync(
    [
      'threadnote-remote-memory-read-cursor-v1',
      principal.tenantId,
      principal.shareId,
      principal.principalId,
      principal.policyDigest,
      principal.sharePolicyDigest,
    ].join('\0'),
  );
}

export function encodeRemoteMemoryReadCursor(state: RemoteMemoryReadCursorState, key: string): string {
  assertRemoteMemoryReadCursorState(state);
  const payload = Buffer.from(
    JSON.stringify({
      e: state.expiresAt,
      h: state.contentHash,
      m: state.mode === 'content' ? 'c' : 'o',
      o: state.position.characterOffset,
      r: state.revision,
      ...(state.section === undefined ? {} : {s: state.section}),
      u: state.uri,
      v: 1,
    }),
    'utf8',
  ).toString('base64url');
  const seal = cursorSeal(key, payload);
  const token = `tnrr1.${seal}.${payload}`;
  if (Buffer.byteLength(token, 'utf8') > REMOTE_MEMORY_READ_CURSOR_MAXIMUM_BYTES) {
    throw new Error('Remote memory read cursor exceeds its transport bound.');
  }
  return token;
}

export function decodeRemoteMemoryReadCursor(
  token: string,
  key: string,
  now: number,
): RemoteMemoryReadCursorState | undefined {
  if (Buffer.byteLength(token, 'utf8') > REMOTE_MEMORY_READ_CURSOR_MAXIMUM_BYTES) return undefined;
  const match = REMOTE_MEMORY_READ_CURSOR.exec(token);
  const suppliedSeal = match?.[1];
  const payload = match?.[2];
  if (!suppliedSeal || !payload || !constantTimeEqual(suppliedSeal, cursorSeal(key, payload))) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== payload) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch {
    return undefined;
  }
  const state = decodeCursorPayload(raw);
  if (!state || state.expiresAt <= now) return undefined;
  try {
    return encodeRemoteMemoryReadCursor(state, key) === token ? state : undefined;
  } catch {
    return undefined;
  }
}

function decodeCursorPayload(value: unknown): RemoteMemoryReadCursorState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    input.v !== 1 ||
    typeof input.e !== 'number' ||
    !Number.isSafeInteger(input.e) ||
    input.e <= 0 ||
    typeof input.h !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.h) ||
    (input.m !== 'c' && input.m !== 'o') ||
    typeof input.o !== 'number' ||
    !Number.isSafeInteger(input.o) ||
    input.o < 0 ||
    input.o > 2_000_000 ||
    typeof input.r !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input.r) ||
    typeof input.u !== 'string' ||
    UTF8.encode(input.u).byteLength > 4_096 ||
    (input.s !== undefined &&
      (typeof input.s !== 'string' || input.s.trim().length === 0 || UTF8.encode(input.s).byteLength > 256))
  ) {
    return undefined;
  }
  return {
    contentHash: input.h,
    expiresAt: input.e,
    mode: input.m === 'c' ? 'content' : 'outline',
    position: {characterOffset: input.o, resourceIndex: 0},
    revision: input.r,
    ...(input.s === undefined ? {} : {section: input.s as string}),
    uri: input.u,
  };
}

function assertRemoteMemoryReadCursorState(state: RemoteMemoryReadCursorState): void {
  const roundTrip = decodeCursorPayload({
    e: state.expiresAt,
    h: state.contentHash,
    m: state.mode === 'content' ? 'c' : 'o',
    o: state.position.characterOffset,
    r: state.revision,
    ...(state.section === undefined ? {} : {s: state.section}),
    u: state.uri,
    v: 1,
  });
  if (!roundTrip || state.position.resourceIndex !== 0) throw new Error('Remote memory read cursor state is invalid.');
}

function cursorSeal(key: string, payload: string): string {
  return sha256HexSync(`${key}\0${payload}`);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
